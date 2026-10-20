import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  locals: [] as Array<Record<string, unknown>>,
  tableCalls: [] as string[],
  selected: [] as unknown[][],
  process: vi.fn(),
}));

vi.mock('@alga-psa/db', () => ({
  tenantDb: () => ({
    table: (name: string) => {
      h.tableCalls.push(name);
      const qb: any = {
        where: () => qb,
        whereIn: () => qb,
        select: async (...cols: unknown[]) => {
          h.selected.push(cols);
          return h.locals;
        },
      };
      return qb;
    },
  }),
}));
vi.mock('../processRmmAlertEvent', () => ({ processRmmAlertEvent: h.process }));

import {
  RECONCILIATION_INGEST_MARKER,
  registerRmmAlertFetcher,
  runRmmAlertReconciliation,
} from '../reconciliation';

const args = { tenantId: 't1', integrationId: 'i1', provider: 'datto' };
const raw = vi.fn((sql: string, bindings: unknown[]) => ({ sql, bindings }));
const ctx = { knex: { raw }, deps: {} } as any;

const triggered = (id: string) =>
  ({ ...args, kind: 'triggered', externalAlertId: id, severity: 'major', occurredAt: '2026-01-01T00:00:00Z', raw: {} }) as any;

describe('runRmmAlertReconciliation', () => {
  beforeEach(() => {
    h.locals = [];
    h.tableCalls = [];
    h.selected = [];
    h.process.mockReset();
    h.process.mockResolvedValue({ outcome: 'resolved', warnings: [] });
    raw.mockClear();
  });

  it('skips the whole cycle, with a warning, when the fetcher cannot say what is open', async () => {
    registerRmmAlertFetcher('datto', { fetchActiveAlerts: async () => null });
    h.locals = [{ external_alert_id: 'a1', ingest_source: 'reconciliation', created_at: '2020-01-01', updated_at: '2020-01-01' }];

    const result = await runRmmAlertReconciliation(ctx, args);

    expect(result).toMatchObject({ skipped: true, remoteActive: 0, ingested: 0, resetsSynthesized: 0 });
    expect(result.warnings).toHaveLength(1);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.tableCalls).toEqual([]);
  });

  it('treats an empty list as authoritative and resets poller-ingested alerts', async () => {
    registerRmmAlertFetcher('datto', { fetchActiveAlerts: async () => [] });
    h.locals = [{ external_alert_id: 'a1', ingest_source: 'reconciliation', created_at: '2020-01-01', updated_at: '2020-01-01' }];

    const result = await runRmmAlertReconciliation(ctx, args);

    expect(result).toMatchObject({ skipped: false, resetsSynthesized: 1 });
    expect(h.process).toHaveBeenCalledWith(ctx, expect.objectContaining({ kind: 'reset', externalAlertId: 'a1' }));
  });

  it('selects only the ingest marker, not the whole metadata document', async () => {
    registerRmmAlertFetcher('datto', { fetchActiveAlerts: async () => [] });
    await runRmmAlertReconciliation(ctx, args);

    expect(raw).toHaveBeenCalledWith('metadata->>? as ingest_source', [RECONCILIATION_INGEST_MARKER]);
    expect(h.selected[0]).toEqual(expect.arrayContaining(['external_alert_id', 'created_at', 'updated_at']));
    expect(h.selected[0]).not.toContain('metadata');
  });

  it('does not reset rows the snapshot cannot speak for: webhook-touched mid-cycle, or not poller-ingested', async () => {
    registerRmmAlertFetcher('datto', {
      fetchActiveAlerts: async () => {
        // A webhook lands after the fetch started.
        const during = new Date(Date.now() + 5).toISOString();
        h.locals = [
          { external_alert_id: 'created-mid-cycle', ingest_source: 'reconciliation', created_at: during, updated_at: during },
          { external_alert_id: 'updated-mid-cycle', ingest_source: 'reconciliation', created_at: '2020-01-01', updated_at: new Date(Date.now() + 5) },
          { external_alert_id: 'not-poller', ingest_source: null, created_at: '2020-01-01', updated_at: '2020-01-01' },
          { external_alert_id: 'stale', ingest_source: 'reconciliation', created_at: '2020-01-01', updated_at: '2020-01-01' },
        ];
        return [];
      },
    });

    const result = await runRmmAlertReconciliation(ctx, args);

    const reset = h.process.mock.calls.map((c) => c[1].externalAlertId);
    expect(reset).toEqual(['stale']);
    expect(result.resetsSynthesized).toBe(1);
  });

  it('does not reset alerts still open remotely', async () => {
    registerRmmAlertFetcher('datto', { fetchActiveAlerts: async () => [triggered('a1')] });
    h.process.mockResolvedValue({ outcome: 'skipped', warnings: [] });
    h.locals = [{ external_alert_id: 'a1', ingest_source: 'reconciliation', created_at: '2020-01-01', updated_at: '2020-01-01' }];

    const result = await runRmmAlertReconciliation(ctx, args);

    expect(result.remoteActive).toBe(1);
    expect(h.process).toHaveBeenCalledTimes(1);
    expect(h.process).toHaveBeenCalledWith(ctx, expect.objectContaining({ kind: 'triggered' }), { reprocessSuppressed: true });
  });
});
