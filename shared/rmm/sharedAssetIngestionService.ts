import type { Knex } from 'knex';
import { createTenantKnex, tenantDb } from '@alga-psa/db';
import { applyRmmSignedInUserAssignment } from './autoAssignFromSignedInUser';
import {
  findDuplicateAssetForRmmDevice,
  isAssetOwnedByAnotherRmm,
  lockAssetIdentity,
  recordAssetMacAddresses,
} from './assetDeduplication';
import type {
  NormalizedRmmDeviceType,
  NormalizedRmmExternalDeviceSnapshot,
  NormalizedRmmIngestionResult,
} from './contracts';

type SupportedAssetType = Extract<NormalizedRmmDeviceType, 'workstation' | 'server' | 'network_device' | 'mobile_device' | 'unknown'>;

export interface IngestNormalizedRmmDeviceSnapshotInput {
  tenant: string;
  snapshot: NormalizedRmmExternalDeviceSnapshot;
  resolvedClientId?: string | null;
  /**
   * The scope's organization mapping, when the caller already holds it. A bulk
   * sync reads it once per site; leaving this undefined makes ingestion read it
   * per device.
   */
  scopeMapping?: { client_id?: string | null; contact_assignment_mode?: string | null } | null;
  knex?: Knex;
}

type ExternalMappingRow = {
  id: string;
  alga_entity_id: string;
  external_realm_id?: string | null;
};

type ExistingAssetRow = {
  asset_id: string;
  asset_type: SupportedAssetType;
  client_id?: string | null;
  rmm_provider?: string | null;
};

function parseIsoDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeAssetType(assetType: NormalizedRmmDeviceType): SupportedAssetType {
  if (assetType === 'workstation' || assetType === 'server' || assetType === 'network_device' || assetType === 'mobile_device') {
    return assetType;
  }
  return 'unknown';
}

/**
 * Hardware identity columns the provider owns (FR-A3). A thin payload must
 * never blank a value a richer run — or a technician — already filled, so an
 * empty manufacturer/model is omitted from the patch entirely.
 */
function buildHardwareIdentityPatch(
  snapshot: NormalizedRmmExternalDeviceSnapshot
): Record<string, string> {
  const ext = snapshot.extension ?? {};
  const patch: Record<string, string> = {};
  const manufacturer = typeof ext.manufacturer === 'string' ? ext.manufacturer.trim() : '';
  const model = typeof ext.model === 'string' ? ext.model.trim() : '';
  if (manufacturer) patch.manufacturer = manufacturer;
  if (model) patch.model = model;
  return patch;
}

function pickExtensionTable(assetType: SupportedAssetType): 'workstation_assets' | 'server_assets' | null {
  if (assetType === 'server') return 'server_assets';
  if (assetType === 'workstation') return 'workstation_assets';
  return null;
}

/** The organization mapping's people mode and client, in one read (FR-D4). */
async function loadScopeMapping(
  trx: Knex.Transaction,
  args: { tenant: string; integrationId: string; externalScopeId: string }
): Promise<{ client_id?: string | null; contact_assignment_mode?: string | null } | null> {
  const db = tenantDb(trx, args.tenant);
  const mapping = await db.table('rmm_organization_mappings')
    .where({
      integration_id: args.integrationId,
      external_organization_id: args.externalScopeId,
    })
    .first<{ client_id?: string | null; contact_assignment_mode?: string | null }>(
      'client_id',
      'contact_assignment_mode'
    );
  return mapping ?? null;
}

async function upsertAssetExtension(
  trx: Knex.Transaction,
  args: { tenant: string; assetId: string; assetType: SupportedAssetType; snapshot: NormalizedRmmExternalDeviceSnapshot; }
): Promise<void> {
  const table = pickExtensionTable(args.assetType);
  if (!table) return;

  const ext = args.snapshot.extension ?? {};
  const patch: Record<string, unknown> = {
    os_type: ext.osType ?? null,
    os_version: ext.osVersion ?? null,
    agent_version: ext.agentVersion ?? null,
    current_user: ext.currentUser ?? null,
    uptime_seconds: ext.uptimeSeconds ?? null,
    lan_ip: ext.lanIp ?? null,
    wan_ip: ext.wanIp ?? null,
    antivirus_status: ext.antivirusStatus ?? null,
    antivirus_product: ext.antivirusProduct ?? null,
    last_reboot_at: parseIsoDate(ext.lastRebootAt),
    pending_patches: ext.pendingPatches ?? null,
    pending_os_patches: ext.pendingOsPatches ?? null,
    pending_software_patches: ext.pendingSoftwarePatches ?? null,
    failed_patches: ext.failedPatches ?? null,
    last_patch_scan_at: parseIsoDate(ext.lastPatchScanAt),
    system_info: ext.systemInfo ? JSON.stringify(ext.systemInfo) : null,
  };

  if (typeof ext.cpuModel !== 'undefined') {
    patch.cpu_model = ext.cpuModel ?? null;
  }

  if (typeof ext.cpuCores !== 'undefined') {
    patch.cpu_cores = ext.cpuCores ?? null;
  }

  if (typeof ext.ramGb !== 'undefined') {
    patch.ram_gb = ext.ramGb ?? null;
  }

  if (typeof ext.diskUsage !== 'undefined') {
    patch.disk_usage = ext.diskUsage ? JSON.stringify(ext.diskUsage) : null;
  }

  if (typeof ext.installedSoftware !== 'undefined') {
    patch.installed_software = JSON.stringify(ext.installedSoftware ?? []);
  }

  const db = tenantDb(trx, args.tenant);
  await db.table(table)
    .insert({
      tenant: args.tenant,
      asset_id: trx.raw('?::uuid', [args.assetId]),
      ...patch,
    })
    .onConflict(['tenant', 'asset_id'])
    .merge(patch);
}

async function markMappedAssetDeleted(
  trx: Knex.Transaction,
  args: {
    tenant: string;
    provider: string;
    mappingId: string;
    assetId: string;
    externalDeviceId: string;
    externalScopeId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<NormalizedRmmIngestionResult> {
  const now = new Date().toISOString();
  const db = tenantDb(trx, args.tenant);

  // One agent being removed does not retire a machine another, still-mapped
  // RMM owns: only this provider's link and MACs go.
  const asset = await db.table('assets')
    .where({ asset_id: args.assetId })
    .first<{ rmm_provider?: string | null } | undefined>('rmm_provider');
  const secondary = await isAssetOwnedByAnotherRmm(trx, args.tenant, {
    assetId: args.assetId,
    assetRmmProvider: asset?.rmm_provider,
    provider: args.provider,
  });

  if (secondary) {
    await recordAssetMacAddresses(trx, args.tenant, { assetId: args.assetId, provider: args.provider, macAddresses: [] });
  } else {
    await db.table('assets')
      .where({ asset_id: args.assetId })
      .update({
        // FR-B6: a deleted/tombstoned device is retired; connectivity lives in
        // agent_status.
        status: 'retired',
        agent_status: 'offline',
        last_rmm_sync_at: trx.fn.now(),
        updated_at: now,
      });
  }

  await db.table('tenant_external_entity_mappings')
    .where({ id: args.mappingId })
    .update({
      sync_status: 'error',
      last_synced_at: trx.fn.now(),
      metadata: {
        ...(args.metadata ?? {}),
        deleted: true,
        deletedAt: now,
      },
      updated_at: now,
    });

  return {
    externalDeviceId: args.externalDeviceId,
    assetId: args.assetId,
    action: 'marked_deleted',
    ownership: secondary ? 'secondary' : 'primary',
  };
}

/** Points this provider's device mapping at `assetId`, creating it if needed. */
async function upsertDeviceMapping(
  trx: Knex.Transaction,
  tenant: string,
  snapshot: NormalizedRmmExternalDeviceSnapshot,
  assetId: string,
  mappingId: string | null
): Promise<void> {
  const db = tenantDb(trx, tenant);
  if (mappingId) {
    await db.table('tenant_external_entity_mappings')
      .where({ id: mappingId })
      .update({
        external_realm_id: snapshot.externalScopeId,
        sync_status: 'synced',
        last_synced_at: trx.fn.now(),
        metadata: snapshot.metadata ?? {},
      });
    return;
  }
  const now = new Date().toISOString();
  await db.table('tenant_external_entity_mappings').insert({
    tenant,
    integration_type: snapshot.provider,
    alga_entity_type: 'asset',
    alga_entity_id: assetId,
    external_entity_id: snapshot.externalDeviceId,
    external_realm_id: snapshot.externalScopeId,
    sync_status: 'synced',
    last_synced_at: trx.fn.now(),
    metadata: snapshot.metadata ?? {},
    created_at: now,
    updated_at: now,
  });
}

/** Records the snapshot's MACs when the provider read them this run. */
async function recordSnapshotMacs(
  trx: Knex.Transaction,
  tenant: string,
  snapshot: NormalizedRmmExternalDeviceSnapshot,
  assetId: string
): Promise<void> {
  if (!Array.isArray(snapshot.macAddresses)) return;
  await recordAssetMacAddresses(trx, tenant, {
    assetId,
    provider: snapshot.provider,
    macAddresses: snapshot.macAddresses,
  });
}

export async function ingestNormalizedRmmDeviceSnapshot(
  input: IngestNormalizedRmmDeviceSnapshotInput
): Promise<NormalizedRmmIngestionResult> {
  const { tenant, snapshot } = input;
  const knex = input.knex ?? (await createTenantKnex()).knex;
  const assetType = normalizeAssetType(snapshot.assetType);

  return knex.transaction(async (trx) => {
    const db = tenantDb(trx, tenant);

    const exactMapping = await db.table('tenant_external_entity_mappings')
      .where({
        integration_type: snapshot.provider,
        alga_entity_type: 'asset',
        external_entity_id: snapshot.externalDeviceId,
        external_realm_id: snapshot.externalScopeId,
      })
      .first<ExternalMappingRow>('id', 'alga_entity_id', 'external_realm_id');

    const anyRealmMapping = exactMapping
      ? null
      : await db.table('tenant_external_entity_mappings')
          .where({
            integration_type: snapshot.provider,
            alga_entity_type: 'asset',
            external_entity_id: snapshot.externalDeviceId,
          })
          .first<ExternalMappingRow>('id', 'alga_entity_id', 'external_realm_id');

    const existingMapping = exactMapping ?? anyRealmMapping;

    if (snapshot.lifecycleState === 'deleted' || snapshot.lifecycleState === 'tombstoned') {
      if (!existingMapping?.alga_entity_id) {
        return {
          externalDeviceId: snapshot.externalDeviceId,
          action: 'skipped',
          error: 'No existing mapping to mark as deleted',
        };
      }

      return markMappedAssetDeleted(trx, {
        tenant,
        provider: snapshot.provider,
        mappingId: existingMapping.id,
        assetId: String(existingMapping.alga_entity_id),
        externalDeviceId: snapshot.externalDeviceId,
        externalScopeId: snapshot.externalScopeId,
        metadata: snapshot.metadata,
      });
    }

    let existingAsset: ExistingAssetRow | null = null;
    let mappingId: string | null = null;

    if (existingMapping?.alga_entity_id) {
      existingAsset = await db.table('assets')
        .where({ asset_id: existingMapping.alga_entity_id })
        .first<ExistingAssetRow>('asset_id', 'asset_type', 'client_id', 'rmm_provider');
      mappingId = existingMapping.id;
    }

    if (!existingAsset) {
      existingAsset = await db.table('assets')
        .where({
          rmm_provider: snapshot.provider,
          rmm_device_id: snapshot.externalDeviceId,
        })
        .first<ExistingAssetRow>('asset_id', 'asset_type', 'client_id', 'rmm_provider');
    }

    if (!mappingId && existingAsset?.asset_id) {
      const assetScopedMapping = await db.table('tenant_external_entity_mappings')
        .where({
          integration_type: snapshot.provider,
          alga_entity_type: 'asset',
          alga_entity_id: existingAsset.asset_id,
        })
        .first<ExternalMappingRow>('id', 'alga_entity_id', 'external_realm_id');

      if (assetScopedMapping?.id) {
        mappingId = assetScopedMapping.id;
      }
    }

    const lastSeenAt = parseIsoDate(snapshot.lastSeenAt);
    // FR-B6: ingestion owns exactly two lifecycle slugs, `active` and
    // `inactive`, and writes them only on create. `snapshot.status` is a loose
    // `string`, so a provider that invents its own word would otherwise land a
    // slug no asset_statuses row defines; anything else falls back to the
    // connectivity reading instead.
    const snapshotStatus = snapshot.status === 'active' || snapshot.status === 'inactive'
      ? snapshot.status
      : null;
    const assetStatus = snapshotStatus ?? (snapshot.lifecycleState === 'offline' ? 'inactive' : 'active');
    const agentStatus = snapshot.agentStatus ?? (snapshot.lifecycleState === 'offline' ? 'offline' : 'online');
    const scopeMapping = typeof input.scopeMapping !== 'undefined'
      ? input.scopeMapping
      : await loadScopeMapping(trx, {
          tenant,
          integrationId: snapshot.integrationId,
          externalScopeId: snapshot.externalScopeId,
        });
    const resolvedClientId = input.resolvedClientId
      ?? (scopeMapping?.client_id ? String(scopeMapping.client_id) : null);
    const assignmentMode = scopeMapping?.contact_assignment_mode ?? 'suggest';

    if (existingAsset?.asset_id) {
      const assetId = String(existingAsset.asset_id);

      // Another RMM owns this machine's asset (see assetDeduplication.ts):
      // keep this provider's link and MACs current and leave the asset to it.
      if (await isAssetOwnedByAnotherRmm(trx, tenant, {
        assetId,
        assetRmmProvider: existingAsset.rmm_provider,
        provider: snapshot.provider,
      })) {
        await upsertDeviceMapping(trx, tenant, snapshot, assetId, mappingId);
        await recordSnapshotMacs(trx, tenant, snapshot, assetId);
        return {
          externalDeviceId: snapshot.externalDeviceId,
          assetId,
          action: 'updated',
          ownership: 'secondary',
        };
      }

      // FR-B6: `status` is the human lifecycle state and is set only on
      // create. Sync owns `agent_status` (connectivity), not `status`, so an
      // MSP's "In repair" survives every run.
      const assetPatch: Record<string, unknown> = {
        asset_type: assetType,
        name: snapshot.displayName,
        serial_number: snapshot.serialNumber ?? '',
        location: snapshot.location ?? '',
        rmm_provider: snapshot.provider,
        rmm_device_id: snapshot.externalDeviceId,
        rmm_organization_id: snapshot.externalScopeId,
        agent_status: agentStatus,
        last_seen_at: lastSeenAt,
        last_rmm_sync_at: trx.fn.now(),
        ...buildHardwareIdentityPatch(snapshot),
      };

      // FR-G5: sync no longer re-stamps `client_id` on update. A manual client
      // change on an RMM-synced asset now survives every run, and re-pointing
      // an RMM organization moves its devices immediately through
      // moveRmmOrganizationAssets instead of drifting back on the next sync.
      await db.table('assets')
        .where({ asset_id: assetId })
        .update(assetPatch);

      await upsertAssetExtension(trx, {
        tenant,
        assetId,
        assetType,
        snapshot,
      });

      // FR-D4: assignment from the signed-in user runs after the extension row
      // so the matcher sees the value this run reported.
      // The asset's own client, not the mapping's: sync no longer moves it
      // (FR-G5), so a manually moved device matches against where it is now.
      const assignmentClientId = existingAsset.client_id ? String(existingAsset.client_id) : resolvedClientId;
      if (assignmentClientId) {
        await applyRmmSignedInUserAssignment(trx, {
          tenant,
          assetId,
          clientId: assignmentClientId,
          integrationId: snapshot.integrationId,
          provider: snapshot.provider,
          mode: assignmentMode,
          currentUser: snapshot.extension?.currentUser ?? null,
        });
      }

      await upsertDeviceMapping(trx, tenant, snapshot, assetId, mappingId);
      await recordSnapshotMacs(trx, tenant, snapshot, assetId);

      return {
        externalDeviceId: snapshot.externalDeviceId,
        assetId,
        action: 'updated',
        ownership: 'primary',
      };
    }

    if (!resolvedClientId) {
      return {
        externalDeviceId: snapshot.externalDeviceId,
        action: 'skipped',
        error: `No mapped client for external scope ${snapshot.externalScopeId}`,
      };
    }

    // Creation for one (client, name) is serialized, then re-checked: a
    // concurrent run (webhook vs. sync, or another RMM) may have just made it.
    await lockAssetIdentity(trx, tenant, resolvedClientId, snapshot.displayName);
    const createdMeanwhile = await db.table('assets')
      .where({ rmm_provider: snapshot.provider, rmm_device_id: snapshot.externalDeviceId })
      .first<{ asset_id: string } | undefined>('asset_id');
    if (createdMeanwhile?.asset_id) {
      return {
        externalDeviceId: snapshot.externalDeviceId,
        assetId: String(createdMeanwhile.asset_id),
        action: 'skipped',
        error: 'Asset was created by a concurrent sync; it is updated on the next run',
      };
    }

    // The same machine may already have an asset from another RMM.
    const duplicateAssetId = await findDuplicateAssetForRmmDevice(trx, tenant, {
      provider: snapshot.provider,
      clientId: resolvedClientId,
      displayName: snapshot.displayName,
      macAddresses: snapshot.macAddresses,
    });
    if (duplicateAssetId) {
      await upsertDeviceMapping(trx, tenant, snapshot, duplicateAssetId, null);
      await recordSnapshotMacs(trx, tenant, snapshot, duplicateAssetId);
      return {
        externalDeviceId: snapshot.externalDeviceId,
        assetId: duplicateAssetId,
        action: 'linked',
        ownership: 'secondary',
      };
    }

    const now = new Date().toISOString();
    const [createdAsset] = await db.table('assets')
      .insert({
        tenant,
        asset_type: assetType,
        client_id: resolvedClientId,
        asset_tag: snapshot.assetTag || `${snapshot.provider}:${snapshot.externalDeviceId}`,
        serial_number: snapshot.serialNumber ?? '',
        name: snapshot.displayName,
        status: assetStatus,
        location: snapshot.location ?? '',
        rmm_provider: snapshot.provider,
        rmm_device_id: snapshot.externalDeviceId,
        rmm_organization_id: snapshot.externalScopeId,
        agent_status: agentStatus,
        last_seen_at: lastSeenAt,
        last_rmm_sync_at: now,
        ...buildHardwareIdentityPatch(snapshot),
        created_at: now,
        updated_at: now,
      })
      .returning<{ asset_id: string }[]>('asset_id');

    const createdAssetId = String(createdAsset.asset_id);

    await upsertAssetExtension(trx, {
      tenant,
      assetId: createdAssetId,
      assetType,
      snapshot,
    });

    await applyRmmSignedInUserAssignment(trx, {
      tenant,
      assetId: createdAssetId,
      clientId: resolvedClientId,
      integrationId: snapshot.integrationId,
      provider: snapshot.provider,
      mode: assignmentMode,
      currentUser: snapshot.extension?.currentUser ?? null,
    });

    await upsertDeviceMapping(trx, tenant, snapshot, createdAssetId, null);
    await recordSnapshotMacs(trx, tenant, snapshot, createdAssetId);

    return {
      externalDeviceId: snapshot.externalDeviceId,
      assetId: createdAssetId,
      action: 'created',
      ownership: 'primary',
    };
  });
}

export interface RmmDeviceLivenessTouch {
  assetId: string;
  assetType: NormalizedRmmDeviceType;
  lastSeenAt?: string | null;
  uptimeSeconds?: number | null;
}

/**
 * Refreshes only the readings that move on every poll (last seen, uptime, last
 * sync time) for assets whose snapshot is otherwise unchanged, in one UPDATE per
 * table instead of a full ingest per device. Callers decide "unchanged"; this
 * writes nothing else, so it cannot clobber an admin-owned field.
 */
export async function touchRmmDeviceLiveness(
  knex: Knex | Knex.Transaction,
  tenant: string,
  rows: RmmDeviceLivenessTouch[]
): Promise<void> {
  if (!rows.length) return;

  const assetValues = rows.map(() => '(?::uuid, ?::timestamptz)').join(', ');
  const assetBindings = rows.flatMap((row) => [row.assetId, parseIsoDate(row.lastSeenAt)]);
  await knex.raw(
    `UPDATE assets AS a
        SET last_seen_at = v.last_seen_at,
            last_rmm_sync_at = now()
       FROM (VALUES ${assetValues}) AS v(asset_id, last_seen_at)
      WHERE a.tenant = ?::uuid AND a.asset_id = v.asset_id`,
    [...assetBindings, tenant]
  );

  const byTable = new Map<string, RmmDeviceLivenessTouch[]>();
  for (const row of rows) {
    const table = pickExtensionTable(normalizeAssetType(row.assetType));
    if (!table) continue;
    const list = byTable.get(table) ?? [];
    list.push(row);
    byTable.set(table, list);
  }
  for (const [table, list] of byTable) {
    const values = list.map(() => '(?::uuid, ?::bigint)').join(', ');
    const bindings = list.flatMap((row) => [row.assetId, row.uptimeSeconds ?? null]);
    await knex.raw(
      `UPDATE ${table} AS e
          SET uptime_seconds = v.uptime_seconds
         FROM (VALUES ${values}) AS v(asset_id, uptime_seconds)
        WHERE e.tenant = ?::uuid AND e.asset_id = v.asset_id`,
      [...bindings, tenant]
    );
  }
}
