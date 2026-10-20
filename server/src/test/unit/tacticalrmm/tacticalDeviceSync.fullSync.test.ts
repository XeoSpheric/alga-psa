import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const dedup = vi.hoisted(() => ({
  lockAssetIdentity: vi.fn(async () => undefined),
  findDuplicateAssetForRmmDevice: vi.fn(async (): Promise<string | null> => null),
  recordAssetMacAddresses: vi.fn(async () => undefined),
  isAssetOwnedByAnotherRmm: vi.fn(async () => false),
}));

let secretProvider: { getTenantSecret: (tenant: string, key: string) => Promise<string | null> };
let knexMock: any;

let tacticalSites: any[] = [];
let tacticalAgentsByClientId: Record<string, any[]> = {};

let nextAssetId = 0;
let nextMappingId = 0;

type DbState = {
  rmm_integrations: Array<any>;
  rmm_organization_mappings: Array<any>;
  assets: Array<any>;
  workstation_assets: Array<any>;
  server_assets: Array<any>;
  tenant_external_entity_mappings: Array<any>;
};

function createFakeKnex(state: DbState) {
  const now = new Date('2026-02-13T12:00:00.000Z');

  function tableRows(table: string): any[] {
    const key = table.replace(/\s+as\s+\w+$/i, '') as keyof DbState;
    const rows = (state as any)[key];
    if (!rows) throw new Error(`Unknown table: ${table}`);
    return rows;
  }

  function applySelect(row: any, cols?: string[]) {
    if (!cols || cols.length === 0) return row;
    const out: any = {};
    for (const c of cols) {
      // Support "c.client_name as company_name" patterns by returning undefined for non-existing keys.
      const m = c.match(/(.+)\s+as\s+(.+)/i);
      if (m) {
        out[m[2]!.trim()] = (row as any)[m[1]!.trim()];
      } else {
        out[c] = (row as any)[c];
      }
    }
    return out;
  }

  function matchesWhere(row: any, where: Record<string, any>) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  class QB {
    private _where: Record<string, any>[] = [];
    private _whereNot: Record<string, any>[] = [];
    private _notIn: Array<{ col: string; vals: any[] }> = [];
    private _notNull: string[] = [];
    private _andWhere: Array<{ col: string; val: any }> = [];
    private _rawTextEq: { col: string; val: string } | null = null;

    constructor(private readonly table: string) {}

    where(where: Record<string, any>) {
      this._where.push(where);
      return this;
    }

    whereNot(where: Record<string, any>) {
      this._whereNot.push(where);
      return this;
    }

    whereNotIn(col: string, vals: any[]) {
      this._notIn.push({ col, vals: (vals ?? []).map((v) => String(v)) });
      return this;
    }

    whereNotNull(col: string) {
      this._notNull.push(col);
      return this;
    }

    andWhere(col: string, val: any) {
      this._andWhere.push({ col, val });
      return this;
    }

    whereRaw(sql: string, bindings: any[]) {
      // Only support: 'assets.asset_id::text = ?'
      const m = sql.match(/assets\.asset_id::text\s*=\s*\?/i);
      if (m) {
        this._rawTextEq = { col: 'asset_id', val: String(bindings?.[0] ?? '') };
        return this;
      }
      throw new Error(`Unsupported whereRaw: ${sql}`);
    }

    private filtered(): any[] {
      let rows = [...tableRows(this.table)];
      for (const w of this._where) rows = rows.filter((r) => matchesWhere(r, w));
      for (const w of this._whereNot) rows = rows.filter((r) => !matchesWhere(r, w));
      for (const ni of this._notIn) rows = rows.filter((r) => !ni.vals.includes(String(r[ni.col])));
      for (const nn of this._notNull) rows = rows.filter((r) => r[nn] !== null && typeof r[nn] !== 'undefined');
      for (const aw of this._andWhere) rows = rows.filter((r) => r[aw.col] === aw.val);
      if (this._rawTextEq) rows = rows.filter((r) => String(r[this._rawTextEq!.col]) === this._rawTextEq!.val);
      return rows;
    }

    async select(cols?: string[] | string) {
      const colsArr = typeof cols === 'string' ? [cols] : cols;
      return this.filtered().map((r) => applySelect(r, colsArr as any));
    }

    async first(cols?: string[] | string) {
      const colsArr = typeof cols === 'string' ? [cols] : cols;
      const row = this.filtered()[0];
      if (!row) return undefined;
      return applySelect(row, colsArr as any);
    }

    insert(row: any) {
      const rows = tableRows(this.table);
      const toInsert = { ...row };

      // Unwrap knex.raw('?::uuid', [id]) used by the sync engine for extension inserts.
      if (toInsert.asset_id && typeof toInsert.asset_id === 'object' && 'bindings' in toInsert.asset_id) {
        toInsert.asset_id = String((toInsert.asset_id as any).bindings?.[0] ?? '');
      }

      if (this.table === 'tenant_external_entity_mappings') {
        toInsert.id = toInsert.id ?? `mapping_${++nextMappingId}`;
      }

      if (this.table === 'assets' && !toInsert.asset_id) {
        toInsert.asset_id = `asset_${++nextAssetId}`;
      }

      rows.push(toInsert);

      // Support onConflict merge for workstation/server assets only, plus
      // insert(...).returning([...]) used by direct asset creation in the sync engine.
      return {
        onConflict: (_cols: string[]) => ({
          merge: async (mergePatch: any) => {
            if (this.table !== 'workstation_assets' && this.table !== 'server_assets') return;
            const match = rows.find((r) => r.tenant === toInsert.tenant && String(r.asset_id) === String(toInsert.asset_id));
            if (!match) return;
            Object.assign(match, mergePatch);
          },
        }),
        returning: async (cols?: string[] | string) => {
          const colsArr = typeof cols === 'string' ? [cols] : cols;
          return [applySelect(toInsert, colsArr as any)];
        },
      };
    }

    async update(patch: any) {
      const rows = this.filtered();
      for (const r of rows) Object.assign(r, patch);
      return rows.length;
    }
  }

  const knex = ((table: string) => new QB(table)) as any;
  knex.fn = { now: () => now };
  knex.raw = (sql: string, bindings: any[]) => ({ __raw: sql, bindings });
  // Asset creation runs in a transaction; the fake has no isolation to model.
  knex.transaction = async (fn: (trx: any) => Promise<any>) => fn(knex);
  return knex;
}

vi.mock('@alga-psa/shared/rmm/assetDeduplication', async () => {
  const actual: any = await vi.importActual('@alga-psa/shared/rmm/assetDeduplication');
  return { ...actual, ...dedup };
});

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
  createAsset: vi.fn(async (input: any) => {
    const asset_id = `asset_${++nextAssetId}`;
    // The sync engine updates the assets row after create; insert a minimal base row so updates can find it.
    (knexMock as any)('assets').insert({
      tenant: 'tenant_1',
      asset_id,
      asset_type: input.asset_type,
      name: input.name,
      client_id: input.client_id,
      status: input.status,
      serial_number: input.serial_number,
    });
    return { asset_id };
  }),
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
    async listAllBeta(args: { path: string; params?: any }) {
      if (args.path === '/beta/v1/site/') return tacticalSites;
      if (args.path === '/beta/v1/agent/') {
        const clientId = String(args.params?.client_id ?? '');
        return tacticalAgentsByClientId[clientId] ?? [];
      }
      throw new Error(`Unexpected listAllBeta path: ${args.path}`);
    }

    async request(_args: any) {
      throw new Error('request not implemented in this mock');
    }
  }

  return { ...actual, TacticalRmmClient: TacticalRmmClientMock };
});

describe('Tactical device sync (full sync)', () => {
  let state: DbState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'));

    nextAssetId = 0;
    nextMappingId = 0;

    dedup.lockAssetIdentity.mockClear();
    dedup.findDuplicateAssetForRmmDevice.mockReset().mockResolvedValue(null);
    dedup.recordAssetMacAddresses.mockClear();
    dedup.isAssetOwnedByAnotherRmm.mockReset().mockResolvedValue(false);

    tacticalSites = [{ id: 's1', name: 'HQ' }];
    tacticalAgentsByClientId = {
      '100': [
        {
          agent_id: 'a1',
          hostname: 'pc-1',
          site_id: 's1',
          operating_system: 'Windows 10 Pro 22H2',
          agent_version: '1.2.3',
          last_seen: new Date('2026-02-13T11:59:00.000Z').toISOString(),
          offline_time: 5,
          overdue_time: 30,
        },
      ],
    };

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
      rmm_organization_mappings: [
        {
          tenant: 'tenant_1',
          integration_id: 'integration_1',
          external_organization_id: '100',
          client_id: 'client_1',
          auto_sync_assets: true,
        },
      ],
      assets: [],
      workstation_assets: [],
      server_assets: [],
      tenant_external_entity_mappings: [],
    };

    knexMock = createFakeKnex(state);

    secretProvider = {
      getTenantSecret: vi.fn(async (_tenant: string, key: string) => {
        if (key === 'tacticalrmm_api_key') return 'api_key_1';
        if (key === 'tacticalrmm_instance_url') return 'https://tactical.example';
        return null;
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a new asset and external mapping for an unmapped agent_id', async () => {
    const { syncTacticalRmmDevices } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const res = await syncTacticalRmmDevices({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);
    expect(res.items_processed).toBe(1);
    expect(res.items_created).toBe(1);
    expect(res.items_updated).toBe(0);
    expect(res.items_failed).toBe(0);

    expect(state.tenant_external_entity_mappings).toHaveLength(1);
    expect(state.tenant_external_entity_mappings[0]).toEqual(
      expect.objectContaining({
        tenant: 'tenant_1',
        integration_type: 'tacticalrmm',
        alga_entity_type: 'asset',
        external_entity_id: 'a1',
        external_realm_id: '100',
        metadata: expect.objectContaining({
          site_id: 's1',
          site_name: 'HQ',
        }),
      })
    );
  });

  it('updates existing assets when agent fields change and refreshes last_seen/agent_status', async () => {
    // Seed an existing asset + mapping for agent a1.
    state.assets.push({
      tenant: 'tenant_1',
      asset_id: 'asset_existing',
      asset_type: 'workstation',
      name: 'old-name',
      rmm_provider: 'tacticalrmm',
      rmm_device_id: 'a1',
      rmm_organization_id: '100',
      agent_status: 'offline',
      last_seen_at: null,
      last_rmm_sync_at: null,
    });
    state.tenant_external_entity_mappings.push({
      tenant: 'tenant_1',
      id: 'mapping_existing',
      integration_type: 'tacticalrmm',
      alga_entity_type: 'asset',
      alga_entity_id: 'asset_existing',
      external_entity_id: 'a1',
      external_realm_id: '100',
      sync_status: 'synced',
      last_synced_at: null,
      metadata: {},
    });

    tacticalAgentsByClientId['100'] = [
      {
        agent_id: 'a1',
        hostname: 'pc-1-renamed',
        site_id: 's1',
        operating_system: 'Windows Server 2022',
        agent_version: '9.9.9',
        last_seen: new Date('2026-02-13T11:00:00.000Z').toISOString(),
        offline_time: 5,
        overdue_time: 30,
      },
    ];

    const { syncTacticalRmmDevices } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const res = await syncTacticalRmmDevices({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);
    expect(res.items_processed).toBe(1);
    expect(res.items_created).toBe(0);
    expect(res.items_updated).toBe(1);
    expect(res.items_failed).toBe(0);

    const asset = state.assets.find((a) => a.asset_id === 'asset_existing');
    expect(asset?.name).toBe('pc-1-renamed');
    expect(asset?.agent_status).toBe('overdue');
    expect(asset?.last_seen_at).toBeInstanceOf(Date);
    expect(asset?.last_rmm_sync_at).toBeInstanceOf(Date);
  });

  it('does not inactivate or delete assets when agents disappear (deletion policy = skip)', async () => {
    // Seed an existing asset + mapping for an agent that will not be returned by Tactical.
    state.assets.push({
      tenant: 'tenant_1',
      asset_id: 'asset_missing',
      asset_type: 'workstation',
      name: 'missing-agent-asset',
      status: 'active',
      rmm_provider: 'tacticalrmm',
      rmm_device_id: 'a_missing',
      rmm_organization_id: '100',
      agent_status: 'online',
    });
    state.tenant_external_entity_mappings.push({
      tenant: 'tenant_1',
      id: 'mapping_missing',
      integration_type: 'tacticalrmm',
      alga_entity_type: 'asset',
      alga_entity_id: 'asset_missing',
      external_entity_id: 'a_missing',
      external_realm_id: '100',
      sync_status: 'synced',
      metadata: {},
    });

    tacticalAgentsByClientId['100'] = []; // agent disappeared

    const { syncTacticalRmmDevices } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    const res = await syncTacticalRmmDevices({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);
    expect(res.items_processed).toBe(0);
    expect(res.items_deleted).toBe(0);

    const stillThere = state.assets.find((a) => a.asset_id === 'asset_missing');
    expect(stillThere?.status).toBe('active');
  });

  /**
   * FR-B6: a device Tactical still lists proves the fleet was visible, so one
   * it no longer lists is retired — unlike the empty listing above.
   */
  it('retires a vanished agent when the full sync still sees the fleet', async () => {
    state.assets.push({
      tenant: 'tenant_1',
      asset_id: 'asset_gone',
      asset_type: 'workstation',
      name: 'gone-agent-asset',
      status: 'active',
      rmm_provider: 'tacticalrmm',
      rmm_device_id: 'a_gone',
      rmm_organization_id: '100',
      agent_status: 'online',
    });
    state.tenant_external_entity_mappings.push({
      tenant: 'tenant_1',
      id: 'mapping_gone',
      integration_type: 'tacticalrmm',
      alga_entity_type: 'asset',
      alga_entity_id: 'asset_gone',
      external_entity_id: 'a_gone',
      external_realm_id: '100',
      sync_status: 'synced',
      metadata: {},
    });

    const { syncTacticalRmmDevices } = await import(
      '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
    );

    // Agent a1 is still listed; a_gone is not.
    const res = await syncTacticalRmmDevices({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    expect(res.success).toBe(true);
    expect(res.items_deleted).toBe(1);

    const retired = state.assets.find((a) => a.asset_id === 'asset_gone');
    expect(retired?.status).toBe('retired');
    expect(retired?.agent_status).toBe('offline');

    const mapping = state.tenant_external_entity_mappings.find((m) => m.id === 'mapping_gone');
    expect(mapping?.sync_status).toBe('error');
    expect(mapping?.metadata).toEqual(expect.objectContaining({ deleted: true }));

    // The agent that is still there keeps its lifecycle status.
    const live = state.assets.find((a) => a.rmm_device_id === 'a1');
    expect(live?.status).not.toBe('retired');
  });

  describe('cross-RMM dedup', () => {
    const windowsMacs = {
      network_config: [[{ MACAddress: '00:11:22:33:44:55', IPAddress: ['10.0.0.5'] }], [{ MACAddress: null }]],
    };

    function seedLinkedAsset(rmmProvider: string) {
      state.assets.push({
        tenant: 'tenant_1',
        asset_id: 'asset_existing',
        asset_type: 'workstation',
        name: 'old-name',
        client_id: 'client_1',
        status: 'active',
        rmm_provider: rmmProvider,
        rmm_device_id: 'other-device',
        agent_status: 'online',
      });
      state.tenant_external_entity_mappings.push({
        tenant: 'tenant_1',
        id: 'mapping_existing',
        integration_type: 'tacticalrmm',
        alga_entity_type: 'asset',
        alga_entity_id: 'asset_existing',
        external_entity_id: 'a1',
        external_realm_id: '100',
        sync_status: 'synced',
        metadata: {},
      });
    }

    async function runSync() {
      const { syncTacticalRmmDevices } = await import(
        '@alga-psa/integrations/actions/integrations/tacticalRmmActions'
      );
      return syncTacticalRmmDevices({ user_id: 'u1' } as any, { tenant: 'tenant_1' });
    }

    it('links an agent to the matching asset with only a mapping and records its MACs', async () => {
      tacticalAgentsByClientId['100']![0].wmi_detail = windowsMacs;
      state.assets.push({ tenant: 'tenant_1', asset_id: 'asset_other_rmm', name: 'pc-1', client_id: 'client_1', rmm_provider: 'level' });
      dedup.findDuplicateAssetForRmmDevice.mockResolvedValue('asset_other_rmm');

      const res = await runSync();
      expect(res.success).toBe(true);
      expect(res.items_created).toBe(0);
      expect(res.items_updated).toBe(1);

      expect(dedup.lockAssetIdentity).toHaveBeenCalledWith(expect.anything(), 'tenant_1', 'client_1', 'pc-1');
      expect(dedup.findDuplicateAssetForRmmDevice).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        provider: 'tacticalrmm',
        clientId: 'client_1',
        displayName: 'pc-1',
        macAddresses: ['00:11:22:33:44:55'],
      });

      // No new asset, no write to the other RMM's row.
      expect(state.assets).toHaveLength(1);
      expect(state.assets[0]).toEqual(expect.objectContaining({ rmm_provider: 'level', name: 'pc-1' }));
      expect(state.workstation_assets).toHaveLength(0);
      expect(state.tenant_external_entity_mappings).toEqual([
        expect.objectContaining({
          integration_type: 'tacticalrmm',
          alga_entity_id: 'asset_other_rmm',
          external_entity_id: 'a1',
          external_realm_id: '100',
          metadata: expect.objectContaining({ site_id: 's1', site_name: 'HQ' }),
        }),
      ]);
      expect(dedup.recordAssetMacAddresses).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        assetId: 'asset_other_rmm',
        provider: 'tacticalrmm',
        macAddresses: ['00:11:22:33:44:55'],
      });
    });

    it('creates the asset and records its MACs when no duplicate exists', async () => {
      tacticalAgentsByClientId['100']![0].wmi_detail = windowsMacs;

      const res = await runSync();
      expect(res.items_created).toBe(1);
      expect(res.items_updated).toBe(0);

      expect(state.assets).toHaveLength(1);
      expect(state.assets[0]).toEqual(expect.objectContaining({ name: 'pc-1', rmm_provider: 'tacticalrmm', rmm_device_id: 'a1' }));
      expect(dedup.recordAssetMacAddresses).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        assetId: state.assets[0].asset_id,
        provider: 'tacticalrmm',
        macAddresses: ['00:11:22:33:44:55'],
      });
    });

    it('does not record MACs (so nothing is cleared) when the payload has no network data', async () => {
      const res = await runSync();
      expect(res.items_created).toBe(1);
      expect(dedup.findDuplicateAssetForRmmDevice).toHaveBeenCalledWith(
        expect.anything(),
        'tenant_1',
        expect.objectContaining({ macAddresses: undefined })
      );
      expect(dedup.recordAssetMacAddresses).not.toHaveBeenCalled();
    });

    it('leaves the asset row and extension alone when another RMM owns it, but refreshes mapping and MACs', async () => {
      seedLinkedAsset('level');
      dedup.isAssetOwnedByAnotherRmm.mockResolvedValue(true);
      tacticalAgentsByClientId['100']![0].wmi_detail = windowsMacs;
      tacticalAgentsByClientId['100']![0].hostname = 'tactical-name';

      const res = await runSync();
      expect(res.items_updated).toBe(1);
      expect(res.items_created).toBe(0);

      expect(dedup.isAssetOwnedByAnotherRmm).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        assetId: 'asset_existing',
        assetRmmProvider: 'level',
        provider: 'tacticalrmm',
      });
      expect(state.assets[0]).toEqual(expect.objectContaining({ name: 'old-name', rmm_provider: 'level', rmm_device_id: 'other-device' }));
      expect(state.workstation_assets).toHaveLength(0);
      expect(state.tenant_external_entity_mappings[0]).toEqual(
        expect.objectContaining({ sync_status: 'synced', metadata: expect.objectContaining({ site_name: 'HQ' }) })
      );
      expect(dedup.recordAssetMacAddresses).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        assetId: 'asset_existing',
        provider: 'tacticalrmm',
        macAddresses: ['00:11:22:33:44:55'],
      });
    });

    it('does not retire an asset another still-mapped RMM owns when the agent vanishes', async () => {
      seedLinkedAsset('level');
      state.tenant_external_entity_mappings[0]!.external_entity_id = 'a_gone';
      dedup.isAssetOwnedByAnotherRmm.mockResolvedValue(true);

      const res = await runSync();
      expect(res.items_deleted).toBe(0);

      expect(state.assets[0]).toEqual(expect.objectContaining({ status: 'active', agent_status: 'online' }));
      expect(state.tenant_external_entity_mappings[0]).toEqual(
        expect.objectContaining({ sync_status: 'error', metadata: expect.objectContaining({ deleted: true }) })
      );
      expect(dedup.recordAssetMacAddresses).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
        assetId: 'asset_existing',
        provider: 'tacticalrmm',
        macAddresses: [],
      });
    });
  });
});
