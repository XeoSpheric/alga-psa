import { tenantScopedTable } from './db';

export function normalizeSoftwareName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.+-]/g, '');
}

export async function findOrCreateSoftwareCatalogEntry(
  knex: any,
  tenant: string,
  input: { name: string; publisher?: string | null }
): Promise<string> {
  const normalizedName = normalizeSoftwareName(input.name);
  const publisher = input.publisher ? String(input.publisher).trim() : null;

  const existing = await tenantScopedTable(knex, 'software_catalog', tenant)
    .where({ normalized_name: normalizedName, publisher })
    .first(['software_id']);
  if (existing?.software_id) return existing.software_id;

  const [row] = await tenantScopedTable(knex, 'software_catalog', tenant)
    .insert({
      tenant,
      name: input.name.trim(),
      normalized_name: normalizedName,
      publisher,
      category: 'application',
      software_type: 'application',
      is_managed: false,
      is_security_relevant: false,
    })
    .returning(['software_id']);

  return row.software_id;
}

type SoftwareInput = { name: string; version?: string | null; publisher?: string | null; installPath?: string | null };

// Keeps each query's bind-parameter count well under Postgres' limit.
const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function catalogKey(normalizedName: string, publisher: string | null): string {
  // \u0001 marks a NULL publisher so it never collides with a real value.
  return `${normalizedName}\u0000${publisher ?? '\u0001'}`;
}

/**
 * Resolves catalog ids for every (normalized name, publisher) pair, creating
 * missing entries in bulk. Returns a map keyed by catalogKey().
 */
async function resolveCatalogIds(
  knex: any,
  tenant: string,
  entries: Array<{ name: string; normalizedName: string; publisher: string | null }>
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const loadExisting = async (names: string[]) => {
    for (const batch of chunk(names, BATCH_SIZE)) {
      const rows = await tenantScopedTable(knex, 'software_catalog', tenant)
        .whereIn('normalized_name', batch)
        .select(['software_id', 'normalized_name', 'publisher']);
      for (const row of rows) {
        ids.set(catalogKey(row.normalized_name, row.publisher ?? null), String(row.software_id));
      }
    }
  };

  await loadExisting(Array.from(new Set(entries.map((e) => e.normalizedName))));

  const missing = entries.filter((e) => !ids.has(catalogKey(e.normalizedName, e.publisher)));
  for (const batch of chunk(missing, BATCH_SIZE)) {
    const rows = await tenantScopedTable(knex, 'software_catalog', tenant)
      .insert(
        batch.map((e) => ({
          tenant,
          name: e.name.trim(),
          normalized_name: e.normalizedName,
          publisher: e.publisher,
          category: 'application',
          software_type: 'application',
          is_managed: false,
          is_security_relevant: false,
        }))
      )
      .onConflict(['tenant', 'normalized_name', 'publisher'])
      .ignore()
      .returning(['software_id', 'normalized_name', 'publisher']);
    for (const row of rows) {
      ids.set(catalogKey(row.normalized_name, row.publisher ?? null), String(row.software_id));
    }
  }

  // Rows skipped by ON CONFLICT (created concurrently) return nothing; load them.
  const stillMissing = missing.filter((e) => !ids.has(catalogKey(e.normalizedName, e.publisher)));
  if (stillMissing.length > 0) {
    await loadExisting(Array.from(new Set(stillMissing.map((e) => e.normalizedName))));
  }

  return ids;
}

/**
 * Reconciles an asset's installed-software rows with the list an RMM reported.
 * Runs a fixed handful of set-based queries per asset (catalog lookup/insert,
 * one read of the asset's rows, one upsert, one uninstall update) instead of
 * several queries per program.
 */
export async function syncAssetSoftwareList(
  knex: any,
  tenant: string,
  assetId: string,
  softwareList: SoftwareInput[],
  syncTimestamp: Date = new Date()
): Promise<{ installed: number; uninstalled: number; catalogCreated: number }> {
  const stats = { installed: 0, uninstalled: 0, catalogCreated: 0 };

  // Collapse duplicate reports of the same program; later entries win for
  // version/path but fall back to earlier values, as sequential updates did.
  const reported = new Map<
    string,
    { name: string; normalizedName: string; publisher: string | null; version: string | null; installPath: string | null }
  >();
  for (const sw of softwareList) {
    if (!sw?.name) continue;
    const normalizedName = normalizeSoftwareName(sw.name);
    const publisher = sw.publisher ? String(sw.publisher).trim() : null;
    const key = catalogKey(normalizedName, publisher);
    const previous = reported.get(key);
    reported.set(key, {
      name: previous?.name ?? sw.name,
      normalizedName,
      publisher,
      version: sw.version || previous?.version || null,
      installPath: sw.installPath || previous?.installPath || null,
    });
  }

  const catalogIds = await resolveCatalogIds(knex, tenant, Array.from(reported.values()));

  const existingRows = await tenantScopedTable(knex, 'asset_software', tenant)
    .where({ asset_id: assetId })
    .select(['software_id', 'is_current']);
  const existingById = new Map<string, { is_current: boolean }>(
    existingRows.map((row: { software_id: unknown; is_current: boolean }) => [String(row.software_id), row])
  );

  const upserts = new Map<string, Record<string, unknown>>();
  for (const [key, sw] of reported) {
    const softwareId = catalogIds.get(key);
    if (!softwareId) continue;
    const existing = existingById.get(softwareId);
    if (!existing) {
      stats.installed += 1;
      stats.catalogCreated += 1;
    } else if (!existing.is_current) {
      stats.installed += 1;
    }
    upserts.set(softwareId, {
      tenant,
      asset_id: assetId,
      software_id: softwareId,
      version: sw.version,
      install_path: sw.installPath,
      first_seen_at: syncTimestamp,
      last_seen_at: syncTimestamp,
      is_current: true,
    });
  }

  for (const batch of chunk(Array.from(upserts.values()), BATCH_SIZE)) {
    await tenantScopedTable(knex, 'asset_software', tenant)
      .insert(batch)
      .onConflict(['tenant', 'asset_id', 'software_id'])
      .merge({
        last_seen_at: knex.raw('excluded.last_seen_at'),
        version: knex.raw('COALESCE(excluded.version, asset_software.version)'),
        install_path: knex.raw('COALESCE(excluded.install_path, asset_software.install_path)'),
        uninstalled_at: knex.raw('CASE WHEN asset_software.is_current THEN asset_software.uninstalled_at ELSE NULL END'),
        is_current: true,
      });
  }

  const goneIds: string[] = (existingRows as Array<{ software_id: unknown; is_current: boolean }>)
    .filter((row) => row.is_current && !upserts.has(String(row.software_id)))
    .map((row) => String(row.software_id));
  for (const batch of chunk(goneIds, BATCH_SIZE)) {
    await tenantScopedTable(knex, 'asset_software', tenant)
      .where({ asset_id: assetId, is_current: true })
      .whereIn('software_id', batch)
      .update({ is_current: false, uninstalled_at: syncTimestamp });
  }
  stats.uninstalled = goneIds.length;

  return stats;
}

// Name the Tactical action and the NinjaOne sync already use for this helper.
export const syncAssetSoftwareToNormalizedTables = syncAssetSoftwareList;
