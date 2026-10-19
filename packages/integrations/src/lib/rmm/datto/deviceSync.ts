/**
 * Datto RMM bulk device sync, as a callable engine.
 *
 * Like Tactical's engine this lives outside the actions module on purpose:
 * every export from a 'use server' file is a callable RPC endpoint, so an
 * unauthenticated sync cannot be exported from there. The action keeps the
 * permission check and delegates here; the scheduled job calls this directly
 * with no acting user (the event payload models that as actorType 'SYSTEM').
 *
 * Unlike Tactical's engine this one does not own the asset writes. Each device
 * is normalized to a snapshot and handed to the shared
 * ingestNormalizedRmmDeviceSnapshot, the same path Level.io uses.
 */
import axios from 'axios';
import type { Knex } from 'knex';

import logger from '@alga-psa/core/logger';
import { createTenantKnex } from '@alga-psa/db';
import { ingestNormalizedRmmDeviceSnapshot } from '@alga-psa/shared/rmm/sharedAssetIngestionService';

import { tenantScopedTable } from '../common/db';
import { publishRmmSyncEvent as publishCommonRmmSyncEvent } from '../common/events';
import { axiosErrorToMessage as commonAxiosErrorToMessage } from '../common/errors';
import { buildDattoClientForTenant, getDattoIntegrationRow } from './buildClient';
import {
  DattoRmmAuthError,
  DattoRmmPermissionError,
  type DattoRmmClient,
} from './dattoApiClient';
import {
  dattoTimestampToIso,
  dattoTimestampToMs,
  mapDattoAuditToHardware,
  mapDattoDeviceToSnapshot,
  mapDattoEsxiAuditToHardware,
  mapDattoPrinterAuditToHardware,
  type DattoHardware,
} from './mappers';
import { DATTO_RMM_PROVIDER } from './shared';
import type { DattoDevice } from './types';

const PROVIDER = DATTO_RMM_PROVIDER;

/** Upper bound on simultaneous audit calls, to stay inside Datto's account rate limit. */
export const DATTO_AUDIT_CONCURRENCY = 4;

/** Result shape shared by site sync, device sync, alert backfill and software ingest. */
export interface DattoSyncResult {
  success: boolean;
  items_processed: number;
  items_created: number;
  items_updated: number;
  items_failed: number;
  errors?: string[];
  error?: string;
}

export interface DattoDeviceSyncOptions {
  syncType?: 'full' | 'incremental';
  /** Only devices seen or audited at or after this instant are ingested. */
  since?: Date;
  /**
   * Restrict the run to these site uids. When given, a site is synced even if
   * its auto-sync flag is off (the caller asked for it by name); it still needs
   * a mapped client.
   */
  siteUids?: string[];
}

export async function publishRmmSyncEvent(args: Omit<Parameters<typeof publishCommonRmmSyncEvent>[0], 'provider'>) {
  return publishCommonRmmSyncEvent({ ...args, provider: PROVIDER });
}

/** A failure whose message was written for the UI and is safe to show as-is. */
export class DattoSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DattoSyncConfigError';
  }
}

/**
 * User-facing message for a failed Datto call. The client's own auth and
 * permission errors are already written to be shown; anything else goes
 * through the shared mapper so no URL, header or body can leak.
 */
export function dattoErrorMessage(err: unknown): string {
  if (
    err instanceof DattoSyncConfigError
    || err instanceof DattoRmmAuthError
    || err instanceof DattoRmmPermissionError
  ) {
    return err.message;
  }
  return commonAxiosErrorToMessage(err, 'Datto RMM');
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof DattoRmmPermissionError) return err.status;
  if (axios.isAxiosError(err)) return err.response?.status;
  return undefined;
}

function parseSettings(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseMetadata(value: unknown): Record<string, unknown> {
  return parseSettings(value);
}

/**
 * Whether a device falls inside an incremental window.
 *
 * Datto has no server-side delta, so "incremental" is the same page walk with
 * the result filtered on lastSeen / lastAuditDate. Inclusive at the boundary,
 * and a device with neither timestamp (missing or unparseable) is always
 * considered, so absent data cannot exclude it from every run forever.
 */
export function dattoDeviceChangedSince(device: DattoDevice, since?: Date): boolean {
  if (!since) return true;
  const seen = dattoTimestampToMs(device?.lastSeen);
  const audited = dattoTimestampToMs(device?.lastAuditDate);
  if (seen === null && audited === null) return true;
  const cutoff = since.getTime();
  return (seen !== null && seen >= cutoff) || (audited !== null && audited >= cutoff);
}

/** Which audit endpoint a device class has, if any. */
function auditKindFor(device: DattoDevice): 'device' | 'printer' | 'esxihost' | null {
  const deviceClass = String(device.deviceClass ?? 'device').trim().toLowerCase();
  if (deviceClass === 'device' || deviceClass === '') return 'device';
  if (deviceClass === 'printer') return 'printer';
  if (deviceClass === 'esxihost') return 'esxihost';
  return null;
}

/**
 * Fetches and maps the audit for one device. Returns null when the device has
 * no audit endpoint, or Datto reports none (404). A 403 is thrown through so
 * the caller can stop requesting audits for the rest of the run.
 */
export async function fetchDattoHardware(
  client: Pick<DattoRmmClient, 'getDeviceAudit' | 'getPrinterAudit' | 'getEsxiHostAudit'>,
  device: DattoDevice
): Promise<DattoHardware | null> {
  const kind = auditKindFor(device);
  if (!kind) return null;
  try {
    if (kind === 'printer') return mapDattoPrinterAuditToHardware(await client.getPrinterAudit(device.uid));
    if (kind === 'esxihost') return mapDattoEsxiAuditToHardware(await client.getEsxiHostAudit(device.uid));
    return mapDattoAuditToHardware(await client.getDeviceAudit(device.uid));
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

export interface ExistingDeviceState {
  assetId: string | null;
  storedLastAuditDate: string | null;
  serialNumber: string | null;
}

/**
 * What the last sync left behind for these devices: whether an asset exists,
 * the lastAuditDate recorded on its external mapping, and its current serial.
 * The serial matters because ingestion rewrites serial_number on every update;
 * when the audit is skipped we hand it the existing value back instead of
 * letting an audit-less snapshot blank it.
 */
export async function loadExistingDeviceState(
  knex: Knex,
  tenant: string,
  deviceUids: string[]
): Promise<Map<string, ExistingDeviceState>> {
  const state = new Map<string, ExistingDeviceState>();
  if (!deviceUids.length) return state;

  const mappings: any[] = await tenantScopedTable(knex, 'tenant_external_entity_mappings', tenant)
    .where({ integration_type: PROVIDER, alga_entity_type: 'asset' })
    .whereIn('external_entity_id', deviceUids)
    .select(['external_entity_id', 'alga_entity_id', 'metadata']);

  const assetIds = mappings.map((row) => String(row.alga_entity_id)).filter(Boolean);
  const assets: any[] = assetIds.length
    ? await tenantScopedTable(knex, 'assets', tenant)
        .whereIn('asset_id', assetIds)
        .select(['asset_id', 'serial_number'])
    : [];
  const assetById = new Map<string, any>(assets.map((row) => [String(row.asset_id), row]));

  for (const row of mappings) {
    const asset = assetById.get(String(row.alga_entity_id));
    const metadata = parseMetadata(row.metadata);
    state.set(String(row.external_entity_id), {
      assetId: asset ? String(asset.asset_id) : null,
      storedLastAuditDate: dattoTimestampToIso(metadata.lastAuditDate as any),
      serialNumber: asset?.serial_number ? String(asset.serial_number) : null,
    });
  }
  return state;
}

/** The audit is worth a call only when there is no asset yet or Datto re-audited since. */
function needsAudit(device: DattoDevice, existing: ExistingDeviceState | undefined): boolean {
  if (device.deleted === true) return false;
  if (!auditKindFor(device)) return false;
  if (!existing?.assetId) return true;
  return existing.storedLastAuditDate !== dattoTimestampToIso(device.lastAuditDate);
}

/**
 * Walks every auto-sync-enabled site mapping and upserts its devices as assets.
 * Never deletes: a device missing from the listing is left alone, which is what
 * makes the incremental filter safe.
 */
export async function runDattoRmmDeviceSync(
  args: { tenant: string; actorUserId?: string },
  options: DattoDeviceSyncOptions = {}
): Promise<DattoSyncResult> {
  const { tenant, actorUserId } = args;
  const syncType = options.syncType ?? 'full';
  const since = options.since;
  const siteFilter = options.siteUids?.length ? new Set(options.siteUids.map(String)) : null;
  const startedAt = Date.now();

  const errors: string[] = [];
  // Used for emitting failure events in the catch block.
  let integrationId: string | undefined;
  let knex: Knex | undefined;

  try {
    ({ knex } = await createTenantKnex());
    const integration = await getDattoIntegrationRow(knex, tenant);

    if (!integration?.integration_id) {
      return emptyFailure('Datto RMM is not configured yet. Save settings first.');
    }

    const integrationIdForEvents = String(integration.integration_id);
    integrationId = integrationIdForEvents;

    await publishRmmSyncEvent({
      eventType: 'RMM_SYNC_STARTED',
      tenantId: tenant,
      actorUserId,
      integrationId: integrationIdForEvents,
      syncType: 'devices',
    });

    const client = await buildDattoClientForTenant(tenant, { allowInactive: true });
    if (!client) {
      throw new DattoSyncConfigError('Datto RMM credentials are not configured. Save and test the connection first.');
    }

    await tenantScopedTable(knex, 'rmm_integrations', tenant)
      .where({ provider: PROVIDER })
      .update({ sync_status: 'syncing', sync_error: null });

    let mappingQuery = tenantScopedTable(knex, 'rmm_organization_mappings', tenant)
      .where({ integration_id: integration.integration_id })
      .whereNotNull('client_id');
    if (!siteFilter) mappingQuery = mappingQuery.andWhere('auto_sync_assets', true);
    const allMappings: any[] = await mappingQuery.select([
      'external_organization_id',
      'external_organization_name',
      'client_id',
    ]);
    const mappings = siteFilter
      ? allMappings.filter((row) => siteFilter.has(String(row.external_organization_id)))
      : allMappings;

    let processed = 0;
    let created = 0;
    let updated = 0;
    let pages = 0;
    let devicesSeen = 0;
    let auditCalls = 0;
    // A 403 on the audit endpoints is account-wide (security level), so one is
    // enough to stop asking for the rest of the run.
    let auditForbidden = false;
    const ingestedDeviceUids: string[] = [];

    for (const mapping of mappings) {
      const siteUid = String(mapping.external_organization_id);
      const clientId = String(mapping.client_id);

      for await (const page of client.pageSiteDevices(siteUid)) {
        pages += 1;
        devicesSeen += page.length;
        const devices = page.filter((device) => device?.uid && dattoDeviceChangedSince(device, since));
        if (!devices.length) continue;

        const existing = await loadExistingDeviceState(knex, tenant, devices.map((d) => d.uid));

        const hardwareByUid = new Map<string, DattoHardware | null>();
        const auditFailures = new Map<string, string>();
        const toAudit = auditForbidden ? [] : devices.filter((d) => needsAudit(d, existing.get(d.uid)));
        await mapWithConcurrency(toAudit, DATTO_AUDIT_CONCURRENCY, async (device) => {
          if (auditForbidden) return;
          auditCalls += 1;
          try {
            hardwareByUid.set(device.uid, await fetchDattoHardware(client, device));
          } catch (err) {
            if (httpStatus(err) === 403) {
              auditForbidden = true;
              return;
            }
            auditFailures.set(device.uid, dattoErrorMessage(err));
          }
        });

        for (const device of devices) {
          processed += 1;
          const failure = auditFailures.get(device.uid);
          if (failure) {
            errors.push(`${device.uid}: audit failed: ${failure}`);
            continue;
          }

          try {
            const prior = existing.get(device.uid);
            const audited = hardwareByUid.has(device.uid);
            const hardware = hardwareByUid.get(device.uid) ?? null;
            const snapshot = mapDattoDeviceToSnapshot(device, {
              integrationId: integrationIdForEvents,
              siteUid,
              hardware,
            });
            // Ingestion rewrites serial_number on every update, so a snapshot
            // without one (audit skipped, unavailable, or serial-less) must
            // carry the value the asset already has.
            if (!snapshot.serialNumber && prior?.serialNumber) snapshot.serialNumber = prior.serialNumber;
            // A forbidden audit was never attempted for this device: keep the
            // marker the mapping already had so it is retried on a later run.
            if (!audited && auditForbidden && snapshot.metadata) {
              snapshot.metadata.lastAuditDate = prior?.storedLastAuditDate ?? null;
            }

            const outcome = await ingestNormalizedRmmDeviceSnapshot({
              tenant,
              snapshot,
              resolvedClientId: clientId,
              knex,
            });

            if (outcome.action === 'failed') {
              errors.push(`${device.uid}: ${outcome.error ?? 'ingestion failed'}`);
              continue;
            }
            if (outcome.action === 'created') created += 1;
            if (outcome.action === 'updated' || outcome.action === 'marked_deleted') updated += 1;
            if (outcome.action === 'created' || outcome.action === 'updated') ingestedDeviceUids.push(device.uid);
          } catch (err) {
            errors.push(`${device.uid}: ${dattoErrorMessage(err)}`);
          }
        }
      }
    }

    const fullSweep = syncType === 'full' && !siteFilter;
    await tenantScopedTable(knex, 'rmm_integrations', tenant)
      .where({ provider: PROVIDER })
      .update({
        sync_status: 'completed',
        last_sync_at: knex.fn.now(),
        ...(fullSweep ? { last_full_sync_at: knex.fn.now() } : {}),
        sync_error: errors.length ? errors.slice(0, 5).join('; ') : null,
      });

    await publishRmmSyncEvent({
      eventType: 'RMM_SYNC_COMPLETED',
      tenantId: tenant,
      actorUserId,
      integrationId: integrationIdForEvents,
      syncType: 'devices',
      itemsProcessed: processed,
      itemsCreated: created,
      itemsUpdated: updated,
      itemsFailed: errors.length,
    });

    logger.info('[DattoRmmDeviceSync] run complete', {
      tenant,
      provider: PROVIDER,
      syncType,
      sites: mappings.length,
      pages,
      devices: devicesSeen,
      processed,
      auditCalls,
      requestCount: client.requestCount,
      failed: errors.length,
      durationMs: Date.now() - startedAt,
    });

    await ingestSoftwareAfterSync({
      tenant,
      settings: parseSettings(integration.settings),
      deviceUids: ingestedDeviceUids,
    });

    return {
      success: true,
      items_processed: processed,
      items_created: created,
      items_updated: updated,
      items_failed: errors.length,
      errors: errors.length ? errors : undefined,
    };
  } catch (err) {
    const message = dattoErrorMessage(err);
    if (knex && integrationId) {
      await tenantScopedTable(knex, 'rmm_integrations', tenant)
        .where({ provider: PROVIDER })
        .update({ sync_status: 'error', sync_error: message })
        .catch(() => undefined);
    }
    if (integrationId) {
      await publishRmmSyncEvent({
        eventType: 'RMM_SYNC_FAILED',
        tenantId: tenant,
        actorUserId,
        integrationId,
        syncType: 'devices',
        errorMessage: message,
      });
    }
    logger.warn('[DattoRmmDeviceSync] run failed', {
      tenant,
      provider: PROVIDER,
      syncType,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return {
      success: false,
      error: message,
      items_processed: 0,
      items_created: 0,
      items_updated: 0,
      items_failed: errors.length,
      errors: errors.length ? errors : undefined,
    };
  }
}

function emptyFailure(error: string): DattoSyncResult {
  return {
    success: false,
    error,
    items_processed: 0,
    items_created: 0,
    items_updated: 0,
    items_failed: 0,
  };
}

/**
 * Opt-in follow-up: when the tenant enabled software ingest on sync, pull the
 * software lists for the devices this run just wrote. Loaded dynamically and
 * never allowed to fail the device sync — the assets are already written.
 */
async function ingestSoftwareAfterSync(args: {
  tenant: string;
  settings: Record<string, unknown>;
  deviceUids: string[];
}): Promise<void> {
  if (args.settings.softwareIngestOnSync !== true || !args.deviceUids.length) return;
  try {
    const { runDattoRmmSoftwareIngest } = await import('./softwareIngest');
    const result = await runDattoRmmSoftwareIngest({ tenant: args.tenant, deviceUids: args.deviceUids });
    if (!result.success) {
      logger.warn('[DattoRmmDeviceSync] software ingest after sync reported failure', {
        tenant: args.tenant,
        provider: PROVIDER,
        error: result.error,
      });
    }
  } catch (err) {
    logger.warn('[DattoRmmDeviceSync] software ingest after sync failed', {
      tenant: args.tenant,
      provider: PROVIDER,
      error: dattoErrorMessage(err),
    });
  }
}
