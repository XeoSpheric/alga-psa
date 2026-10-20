import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let secretProvider: { getTenantSecret: (tenant: string, key: string) => Promise<string | null> };
let knexMock: any;

let tacticalSoftwareRows: any[] = [];
let tacticalAgents: any[] = [];
let requestCalls: Array<{ method: string; path: string }> = [];

vi.mock('@alga-psa/auth', () => ({
  withAuth: (fn: any) => fn,
}));

vi.mock('@alga-psa/auth/rbac', () => ({
  hasPermission: vi.fn(async () => true),
}));

vi.mock('@alga-psa/core/secrets', () => ({
  getSecretProviderInstance: vi.fn(async () => secretProvider),
}));

vi.mock('@alga-psa/db', () => ({
  createTenantKnex: vi.fn(async () => ({ knex: knexMock })),
  tenantDb: (conn: any, _tenant: string) => ({
    table: (t: string) => conn(t),
    unscoped: (t: string) => conn(t),
    tenantJoin: (q: any, t: string, _l?: any, _r?: any, o: any = {}) =>
      o?.type === 'left' ? (q.leftJoin?.(t) ?? q) : (q.join?.(t) ?? q),
  }),
}));

vi.mock('@alga-psa/assets/actions/assetActions', () => ({
  createAsset: vi.fn(),
}));

vi.mock('@alga-psa/event-bus/publishers', () => ({
  publishEvent: vi.fn(),
  publishWorkflowEvent: vi.fn(),
  publishNonCatalogWorkflowEvent: vi.fn(async () => undefined),
  publishStoredWorkflowEvent: vi.fn(async () => undefined),
  publishBuiltWorkflowPayload: vi.fn(async () => undefined),
  publishNonCatalogEventByName: vi.fn(async () => undefined),
  publishUnregisteredEventType: vi.fn(async () => undefined),
}));

vi.mock('@alga-psa/integrations/lib/rmm/tacticalrmm/tacticalApiClient', async () => {
  const actual: any = await vi.importActual(
    '@alga-psa/integrations/lib/rmm/tacticalrmm/tacticalApiClient'
  );

  class TacticalRmmClientMock {
    async request(args: any) {
      requestCalls.push({ method: String(args.method), path: String(args.path) });
      if (args.method === 'GET' && args.path === '/software/') return tacticalSoftwareRows;
      throw new Error(`Unexpected Tactical request: ${args.method} ${args.path}`);
    }
    async listAllBeta(args: any) {
      requestCalls.push({ method: 'GET', path: String(args.path) });
      if (args.path === '/beta/v1/agent/') return tacticalAgents;
      throw new Error(`Unexpected Tactical list: ${args.path}`);
    }
    async checkCreds() {
      return { totp: false };
    }
    async login() {
      return { token: 'token' };
    }
  }

  return { ...actual, TacticalRmmClient: TacticalRmmClientMock };
});

type DbState = {
  rmm_integrations: Array<any>;
  tenant_external_entity_mappings: Array<any>;
  software_catalog: Array<any>;
  asset_software: Array<any>;
};

let nextSoftwareId = 0;

function normalizeName(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.+-]/g, '');
}

function createFakeKnex(state: DbState) {
  const now = new Date('2026-02-13T12:00:00.000Z');

  class QB {
    private _where: Record<string, any>[] = [];
    private _whereIn: Array<[string, any[]]> = [];

    constructor(private readonly table: keyof DbState) {}

    where(where: Record<string, any>) {
      this._where.push(where);
      return this;
    }

    whereIn(column: string, values: any[]) {
      this._whereIn.push([column, values]);
      return this;
    }

    private filtered(): any[] {
      let rows = [...state[this.table]];
      for (const w of this._where) {
        rows = rows.filter((r) => Object.entries(w).every(([k, v]) => r[k] === v));
      }
      for (const [column, values] of this._whereIn) {
        rows = rows.filter((r) => values.includes(r[column]));
      }
      return rows;
    }

    async first(cols?: string[] | string) {
      const colsArr = typeof cols === 'string' ? [cols] : cols;
      const row = this.filtered()[0];
      if (!row) return undefined;
      if (!colsArr) return row;
      const picked: any = {};
      for (const c of colsArr) picked[c] = row[c];
      return picked;
    }

    async select(cols?: string[] | string) {
      const colsArr = typeof cols === 'string' ? [cols] : cols;
      if (!colsArr) return this.filtered();
      return this.filtered().map((r) => {
        const picked: any = {};
        for (const c of colsArr) picked[c] = r[c];
        return picked;
      });
    }

    // Models the multi-row insert / ON CONFLICT upsert the shared software
    // ingest issues. Raw merge expressions (COALESCE(excluded.x, ...)) are
    // approximated as "the incoming value, else the existing one".
    insert(rowOrRows: any) {
      const prepared = (Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]).map((row: any) => {
        const inserted = { ...row };
        if (this.table === 'software_catalog') {
          inserted.software_id = inserted.software_id ?? `software_${++nextSoftwareId}`;
          inserted.normalized_name = inserted.normalized_name ?? normalizeName(String(inserted.name ?? ''));
        }
        return inserted;
      });

      const write = (conflict?: string[], merge?: Record<string, any>) => {
        const written: any[] = [];
        for (const row of prepared) {
          const existing = conflict
            ? state[this.table].find((r) => conflict.every((c) => (r[c] ?? null) === (row[c] ?? null)))
            : undefined;
          if (existing) {
            if (!merge) continue;
            for (const [k, v] of Object.entries(merge)) {
              existing[k] = v && typeof v === 'object' && '__raw' in v ? (row[k] ?? existing[k]) : v;
            }
            written.push(existing);
            continue;
          }
          state[this.table].push(row);
          written.push(row);
        }
        return written;
      };

      const result = (run: () => any[]) => {
        let rows: any[] | undefined;
        const once = () => (rows ??= run());
        return {
          returning: async (cols?: string[]) =>
            once().map((r) => {
              if (!cols || cols.length === 0) return r;
              const picked: any = {};
              for (const c of cols) picked[c] = r[c];
              return picked;
            }),
          then: (resolve: any, reject: any) => Promise.resolve().then(() => once().length).then(resolve, reject),
        };
      };

      return {
        ...result(() => write()),
        onConflict: (cols: string[]) => ({
          ignore: () => result(() => write(cols)),
          merge: (patch: Record<string, any>) => result(() => write(cols, patch)),
        }),
      };
    }

    async update(patch: any) {
      const rows = this.filtered();
      for (const r of rows) Object.assign(r, patch);
      return rows.length;
    }
  }

  const knex = ((table: string) => new QB(table as any)) as any;
  knex.fn = { now: () => now };
  knex.raw = (sql: string) => ({ __raw: sql });
  return knex;
}

describe('Tactical software inventory ingest (bulk)', () => {
  let state: DbState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'));

    requestCalls = [];
    nextSoftwareId = 0;

    state = {
      rmm_integrations: [
        {
          tenant: 'tenant_1',
          provider: 'tacticalrmm',
          integration_id: 'integration_1',
          instance_url: 'https://tactical.example',
          settings: { auth_mode: 'api_key' },
        },
      ],
      tenant_external_entity_mappings: [
        {
          tenant: 'tenant_1',
          integration_type: 'tacticalrmm',
          alga_entity_type: 'asset',
          external_entity_id: 'a1',
          alga_entity_id: 'asset_1',
        },
      ],
      software_catalog: [],
      asset_software: [],
    };
    knexMock = createFakeKnex(state);

    secretProvider = {
      getTenantSecret: vi.fn(async (_tenant: string, key: string) => {
        if (key === 'tacticalrmm_api_key') return 'api_key_1';
        return null;
      }),
    };

    // Real Tactical shape: InstalledSoftwareSerializer(many=True) — one row per
    // agent keyed by the agent's numeric pk, with the inventory nested under `software`.
    tacticalAgents = [
      { id: 1, agent_id: 'a1', hostname: 'pc-1' },
      { id: 2, agent_id: 'a2', hostname: 'pc-2' },
    ];
    tacticalSoftwareRows = [
      {
        id: 10,
        agent: 1,
        software: [
          { name: 'App One', version: '1.0.0', publisher: 'Pub', location: 'C:\\AppOne', install_date: '20260101', size: '10 MB', source: 'msi', uninstall: '' },
          { name: 'App Two', version: '2.0.0', publisher: 'Pub', location: '', install_date: '', size: '', source: '', uninstall: '' },
        ],
      },
      {
        id: 11,
        agent: 2,
        software: [{ name: 'Unmapped App', version: '3.0.0', publisher: 'Pub' }],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ingests via GET /software/ plus one agent listing, with no per-agent refresh calls, and writes normalized software tables', async () => {
    const { ingestTacticalRmmSoftwareInventory } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const res = await ingestTacticalRmmSoftwareInventory({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);

    expect(requestCalls).toEqual([
      { method: 'GET', path: '/software/' },
      { method: 'GET', path: '/beta/v1/agent/' },
    ]);
    expect(requestCalls.some((c) => c.method === 'PUT')).toBe(false);

    expect(res.items_processed).toBe(3);
    expect(state.software_catalog.length).toBeGreaterThan(0);
    expect(state.asset_software.length).toBeGreaterThan(0);
    expect(state.asset_software.find((r) => r.install_path === 'C:\\AppOne')).toBeTruthy();
  });

  it('associates ingested software to the correct asset via Tactical agent_id mappings', async () => {
    const { ingestTacticalRmmSoftwareInventory } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const res = await ingestTacticalRmmSoftwareInventory({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);

    // Only mapped agent a1 should produce catalog + asset software rows.
    expect(state.asset_software).toHaveLength(2);
    expect(new Set(state.asset_software.map((r) => r.asset_id))).toEqual(new Set(['asset_1']));

    const names = new Set(state.software_catalog.map((r) => r.name));
    expect(names.has('App One')).toBe(true);
    expect(names.has('App Two')).toBe(true);
    expect(names.has('Unmapped App')).toBe(false);
  });

  it('is idempotent (rerun does not duplicate software_catalog or asset_software rows)', async () => {
    const { ingestTacticalRmmSoftwareInventory } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const first = await ingestTacticalRmmSoftwareInventory({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(first.success).toBe(true);
    expect(state.software_catalog).toHaveLength(2);
    expect(state.asset_software).toHaveLength(2);

    const second = await ingestTacticalRmmSoftwareInventory({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(second.success).toBe(true);
    expect(state.software_catalog).toHaveLength(2);
    expect(state.asset_software).toHaveLength(2);
  });
});
