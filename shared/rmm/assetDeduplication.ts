/**
 * Cross-RMM asset deduplication.
 *
 * The same machine often runs more than one agent (an RMM plus an EDR or a
 * second RMM during a migration). Each provider keys assets by its own device
 * id, so without this every agent would get its own asset. Before a provider
 * creates an asset for a device it has never seen, it looks for an existing
 * asset that is the same machine, which must match on all three of:
 *
 *   - client: the same Alga client,
 *   - name: the same name (trimmed, whitespace collapsed, case-insensitive),
 *   - MAC: at least one MAC address in common.
 *
 * Name and client alone are not enough (two "RECEPTION-PC"s at one client are
 * common after a re-image), and a MAC alone is not either (virtual adapters,
 * docks and USB NICs move between machines). Exactly one candidate links; an
 * ambiguous match creates a new asset rather than guess.
 *
 * Every provider records the MACs it sees in asset_mac_addresses, so a device
 * one RMM already knows can be recognized when the next one reports it.
 */
import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';

/**
 * MACs that are identical on every machine that has them, so they say nothing
 * about which machine a device is (Microsoft KM-TEST loopback adapter).
 */
const SHARED_PLACEHOLDER_MACS = new Set(['02:00:4c:4f:4f:50']);

/**
 * Canonical aa:bb:cc:dd:ee:ff form, or null for anything that is not a usable
 * unicast hardware address: malformed, all zeros, broadcast, multicast (low bit
 * of the first octet), or a known shared placeholder.
 */
export function normalizeMacAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Separators (: - . space) are dropped; anything else makes it unusable.
  const hex = value.toLowerCase().replace(/[\s:.\-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  if (/^0+$/.test(hex) || /^f+$/.test(hex)) return null;
  if (parseInt(hex.slice(0, 2), 16) & 1) return null;
  const mac = hex.match(/.{2}/g)!.join(':');
  return SHARED_PLACEHOLDER_MACS.has(mac) ? null : mac;
}

/** Normalized, de-duplicated and sorted; unusable values are dropped. */
export function normalizeMacAddresses(values: Iterable<unknown> | null | undefined): string[] {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const mac = normalizeMacAddress(value);
    if (mac) set.add(mac);
  }
  return [...set].sort();
}

/**
 * The name key, computed the same way as idx_assets_tenant_normalized_name
 * (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) so the lookup can use it.
 */
export function normalizeAssetNameForMatch(name: unknown): string {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

export interface RmmDeviceIdentity {
  /** The provider about to create an asset (integration_type of its mappings). */
  provider: string;
  clientId: string;
  displayName: string;
  macAddresses: Iterable<unknown> | null | undefined;
}

/**
 * The one existing asset that is this device, or null.
 *
 * Candidates already mapped to a device of the same provider are excluded: two
 * devices of one RMM sharing an asset would overwrite each other on every
 * sync. Retired assets are excluded too, so a device that comes back is not
 * folded into the record of hardware someone decommissioned.
 */
export async function findDuplicateAssetForRmmDevice(
  conn: Knex | Knex.Transaction,
  tenant: string,
  identity: RmmDeviceIdentity
): Promise<string | null> {
  const macs = normalizeMacAddresses(identity.macAddresses);
  const name = normalizeAssetNameForMatch(identity.displayName);
  if (!macs.length || !name || !identity.clientId) return null;

  const result = await conn.raw(
    `SELECT a.asset_id
       FROM assets a
       JOIN asset_mac_addresses m ON m.tenant = a.tenant AND m.asset_id = a.asset_id
      WHERE a.tenant = ?::uuid
        AND a.client_id = ?::uuid
        AND lower(regexp_replace(trim(a.name), '\\s+', ' ', 'g')) = ?
        AND m.mac_address = ANY(?::text[])
        AND a.status <> 'retired'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_external_entity_mappings t
           WHERE t.tenant = a.tenant
             AND t.integration_type = ?
             AND t.alga_entity_type = 'asset'
             AND t.alga_entity_id = a.asset_id::text
        )
      GROUP BY a.asset_id
      LIMIT 2`,
    [tenant, identity.clientId, name, macs, identity.provider]
  );
  const rows = (result?.rows ?? []) as Array<{ asset_id: string }>;
  return rows.length === 1 ? String(rows[0]!.asset_id) : null;
}

/**
 * Serializes asset creation for one (client, name) within the caller's
 * transaction, so two providers (or a webhook and a sync) seeing the same
 * machine at the same moment cannot both miss each other and both insert.
 * Released at commit or rollback.
 */
export async function lockAssetIdentity(
  trx: Knex.Transaction,
  tenant: string,
  clientId: string,
  displayName: string
): Promise<void> {
  const key = `asset-identity:${tenant}:${clientId}:${normalizeAssetNameForMatch(displayName)}`;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
}

/**
 * Replaces the MACs `provider` reports for an asset with `macAddresses`.
 * Other providers' rows for the same asset are left alone. Pass only a list
 * the provider actually reported this run: an empty list clears its MACs.
 */
export async function recordAssetMacAddresses(
  conn: Knex | Knex.Transaction,
  tenant: string,
  args: { assetId: string; provider: string; macAddresses: Iterable<unknown> }
): Promise<void> {
  const macs = normalizeMacAddresses(args.macAddresses);
  const db = tenantDb(conn, tenant);

  const stale = db.table('asset_mac_addresses').where({ asset_id: args.assetId, provider: args.provider });
  await (macs.length ? stale.whereNotIn('mac_address', macs) : stale).delete();
  if (!macs.length) return;

  await db.table('asset_mac_addresses')
    .insert(macs.map((mac) => ({ tenant, asset_id: args.assetId, mac_address: mac, provider: args.provider })))
    .onConflict(['tenant', 'asset_id', 'mac_address', 'provider'])
    .merge({ last_seen_at: conn.fn.now() });
}

/**
 * Whether `assetId` is owned by a provider other than `provider` that is still
 * mapped to it. A second RMM linked to such an asset only records its mapping
 * and MACs; the owner keeps writing the asset, so the two never take turns
 * overwriting name, status, hardware and rmm_device_id. When the owner's
 * mapping is gone (integration removed), the next provider takes over.
 */
export async function isAssetOwnedByAnotherRmm(
  conn: Knex | Knex.Transaction,
  tenant: string,
  args: { assetId: string; assetRmmProvider: string | null | undefined; provider: string }
): Promise<boolean> {
  const owner = args.assetRmmProvider ? String(args.assetRmmProvider) : '';
  if (!owner || owner === args.provider) return false;
  const ownerMapping = await tenantDb(conn, tenant).table('tenant_external_entity_mappings')
    .where({ integration_type: owner, alga_entity_type: 'asset', alga_entity_id: args.assetId })
    .first('id');
  return Boolean(ownerMapping);
}
