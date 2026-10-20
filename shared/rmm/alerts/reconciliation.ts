import type { NormalizedRmmAlertEvent, RmmAlertProcessingContext } from './contracts';
import { tenantDb } from '@alga-psa/db';
import { processRmmAlertEvent } from './processRmmAlertEvent';

/**
 * Marker stamped into the raw payload of poller-ingested alerts. Stale-alert
 * detection only trusts ids from its own ingest source: provider webhooks may
 * use a different alert id space than the provider's list-alerts API (NinjaOne
 * webhooks carry activity ids; its alerts API returns uids), and a false
 * "stale" verdict would close a ticket whose alert is still firing.
 */
export const RECONCILIATION_INGEST_MARKER = '__alga_ingest_source';

export interface RmmActiveAlertFetcher {
  /**
   * Returns every currently-active alert in the RMM as a triggered event, or
   * null when the fetcher cannot say what is open (integration disconnected,
   * nothing mapped to poll). Null is not "nothing is open": an empty array is
   * authoritative and drives resets for every local alert, null must not.
   */
  fetchActiveAlerts(args: { tenantId: string; integrationId: string }): Promise<NormalizedRmmAlertEvent[] | null>;
}

const fetchers = new Map<string, RmmActiveAlertFetcher>();

export function registerRmmAlertFetcher(provider: string, fetcher: RmmActiveAlertFetcher): void {
  fetchers.set(provider, fetcher);
}

export function getRmmAlertFetcher(provider: string): RmmActiveAlertFetcher | undefined {
  return fetchers.get(provider);
}

export interface ReconciliationResult {
  skipped: boolean;
  remoteActive: number;
  ingested: number;
  resetsSynthesized: number;
  warnings: string[];
}

/**
 * One reconciliation cycle for an integration, all through the normal
 * pipeline so rules, dedup, windows, and ticketing apply identically:
 *
 * 1. Active alerts in the RMM that webhooks missed become triggered events
 *    (dedup absorbs near-duplicates; still-suppressed alerts whose window
 *    ended re-enter processing via reprocessSuppressed).
 * 2. Poller-ingested local alerts no longer active in the RMM get synthesized
 *    resets — catching missed reset webhooks, the main source of stale
 *    tickets.
 */
export async function runRmmAlertReconciliation(
  ctx: RmmAlertProcessingContext,
  args: { tenantId: string; integrationId: string; provider: string }
): Promise<ReconciliationResult> {
  const warnings: string[] = [];
  const fetcher = getRmmAlertFetcher(args.provider);
  if (!fetcher) {
    return { skipped: true, remoteActive: 0, ingested: 0, resetsSynthesized: 0, warnings };
  }

  // Captured before the fetch: the snapshot is only trustworthy for rows no
  // webhook has touched since this instant (see the stale-reset loop).
  const cycleStartedAt = new Date();
  const remote = await fetcher.fetchActiveAlerts({
    tenantId: args.tenantId,
    integrationId: args.integrationId,
  });
  if (remote === null) {
    warnings.push('Alert source could not report open alerts (not connected or nothing mapped); reconciliation skipped');
    return { skipped: true, remoteActive: 0, ingested: 0, resetsSynthesized: 0, warnings };
  }

  let ingested = 0;
  for (const event of remote) {
    const stamped: NormalizedRmmAlertEvent = {
      ...event,
      raw: { ...event.raw, [RECONCILIATION_INGEST_MARKER]: 'reconciliation' },
    };
    // One bad alert must not abort the cycle for every alert behind it.
    try {
      const result = await processRmmAlertEvent(ctx, stamped, { reprocessSuppressed: true });
      warnings.push(...result.warnings);
      if (result.outcome !== 'skipped') ingested += 1;
    } catch (error) {
      warnings.push(`Failed to ingest alert ${event.externalAlertId}: ${errorMessage(error)}`);
    }
  }

  const remoteIds = new Set(remote.map((event) => event.externalAlertId));
  const db = tenantDb(ctx.knex, args.tenantId);
  const locals = await db.table('rmm_alerts')
    .where({ integration_id: args.integrationId })
    .whereIn('status', ['active', 'acknowledged', 'suppressed'])
    .select(
      'external_alert_id',
      'created_at',
      'updated_at',
      // Only the marker is needed; skip shipping every alert's full raw payload.
      ctx.knex.raw('metadata->>? as ingest_source', [RECONCILIATION_INGEST_MARKER])
    );

  let resetsSynthesized = 0;
  const now = new Date().toISOString();
  for (const row of locals) {
    if (remoteIds.has(row.external_alert_id)) continue;
    if (!row.ingest_source) continue;
    // A webhook created or touched this row after the fetch began, so the
    // snapshot predates it and its absence from `remote` proves nothing.
    if (touchedSince(row.created_at, cycleStartedAt) || touchedSince(row.updated_at, cycleStartedAt)) continue;

    try {
      const result = await processRmmAlertEvent(ctx, {
        tenantId: args.tenantId,
        integrationId: args.integrationId,
        provider: args.provider as NormalizedRmmAlertEvent['provider'],
        kind: 'reset',
        externalAlertId: row.external_alert_id,
        severity: 'none',
        occurredAt: now,
        raw: { [RECONCILIATION_INGEST_MARKER]: 'reconciliation', reason: 'no_longer_active_in_rmm' },
      });
      warnings.push(...result.warnings);
      if (result.outcome === 'resolved') resetsSynthesized += 1;
    } catch (error) {
      warnings.push(`Failed to reset alert ${row.external_alert_id}: ${errorMessage(error)}`);
    }
  }

  return { skipped: false, remoteActive: remote.length, ingested, resetsSynthesized, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function touchedSince(value: unknown, since: Date): boolean {
  if (value == null) return false;
  const time = new Date(value as string | number | Date).getTime();
  return Number.isFinite(time) && time >= since.getTime();
}
