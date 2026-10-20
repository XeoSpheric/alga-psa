import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Cross-RMM asset dedup in the NinjaOne sync engine.
 *
 * A device another RMM already created an asset for (same client, name and a
 * shared MAC) must be linked with a ninjaone mapping only, and an asset owned by
 * another RMM must never be written by NinjaOne again. The shared helpers are
 * mocked; what is under test is that the engine calls them and acts on the
 * answer.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: any; wheres: any[] }>,
  assetByDeviceId: null as any,
  assetById: null as any,
  findDuplicate: vi.fn(),
  lockIdentity: vi.fn(),
  recordMacs: vi.fn(),
  isOwnedByOther: vi.fn(),
  createdEvent: vi.fn(),
}));

function respond(state: { table: string; op: string; wheres: any[]; first?: boolean }) {
  const hasWhere = (key: string) => state.wheres.some((w) => w && typeof w === 'object' && key in w);
  if (state.table === 'assets') {
    if (state.op === 'insert') return [{ asset_id: 'new-asset', client_id: 'client-1', name: 'RECEPTION-PC' }];
    if (state.op === 'update') return [{ asset_id: 'asset-1', client_id: 'client-1' }];
    if (hasWhere('rmm_device_id')) return h.assetByDeviceId;
    return h.assetById;
  }
  if (state.table === 'rmm_organization_mappings') return { mapping_id: 'org-map-1', client_id: 'client-1' };
  if (state.op === 'select') return state.first ? undefined : [];
  return [];
}

function makeBuilder(table: string) {
  const state: { table: string; op: string; payload?: any; wheres: any[]; first?: boolean } = {
    table,
    op: 'select',
    wheres: [],
  };
  const b: any = {
    where: (w: any) => { state.wheres.push(w); return b; },
    whereNot: (w: any) => { state.wheres.push({ not: w }); return b; },
    whereNotIn: () => b,
    select: () => b,
    returning: () => b,
    insert: (p: any) => { state.op = 'insert'; state.payload = p; return b; },
    update: (p: any) => { state.op = 'update'; state.payload = p; return b; },
    first: () => { state.first = true; return b; },
    then: (resolve: any, reject: any) => {
      h.calls.push(state);
      return Promise.resolve(respond(state)).then(resolve, reject);
    },
  };
  return b;
}

const trx = { raw: vi.fn((sql: string) => sql), fn: { now: () => 'now' } };

vi.mock('@/lib/db', () => ({ createTenantKnex: vi.fn(async () => ({ knex: {} })) }));
vi.mock('@alga-psa/db', () => ({
  tenantDb: () => ({ table: (name: string) => makeBuilder(name) }),
  withTransaction: async (_knex: unknown, cb: (t: unknown) => unknown) => cb(trx),
}));
vi.mock('@alga-psa/core/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/integrations/ninjaone/ninjaOneClient', () => ({ createNinjaOneClient: vi.fn() }));
vi.mock('@alga-psa/workflow-streams', () => ({
  getRedisStreamClient: () => ({ publishEvent: h.createdEvent }),
  buildIntegrationSyncCompletedPayload: vi.fn(() => ({})),
  buildIntegrationSyncFailedPayload: vi.fn(() => ({})),
  buildIntegrationSyncStartedPayload: vi.fn(() => ({})),
}));
vi.mock('server/src/lib/eventBus/publishers', () => ({ publishWorkflowEvent: vi.fn() }));
vi.mock('@alga-psa/shared/rmm/autoAssignFromSignedInUser', () => ({
  applyRmmSignedInUserAssignment: vi.fn(),
}));
vi.mock('@alga-psa/shared/rmm/assetDeduplication', () => ({
  findDuplicateAssetForRmmDevice: h.findDuplicate,
  lockAssetIdentity: h.lockIdentity,
  recordAssetMacAddresses: h.recordMacs,
  isAssetOwnedByAnotherRmm: h.isOwnedByOther,
}));

const { NinjaOneSyncEngine } = await import('../../lib/integrations/ninjaone/sync/syncEngine');

const device: any = {
  id: 7,
  organizationId: 5,
  displayName: 'RECEPTION-PC',
  systemName: 'reception-pc',
  nodeClass: 'WINDOWS_WORKSTATION',
  offline: false,
  lastContact: 1_790_000_000,
  networkInterfaces: [{ macAddress: 'AA-BB-CC-DD-EE-01' }, { macAddress: 'aa:bb:cc:dd:ee:02' }],
};
const deviceMacs = ['AA-BB-CC-DD-EE-01', 'aa:bb:cc:dd:ee:02'];

function makeEngine(detail: any = device) {
  const engine: any = new NinjaOneSyncEngine('tenant-1', 'integration-1');
  engine.initialize = async () => {};
  engine.knex = {};
  engine.auditUserId = null;
  engine.client = { getDevice: vi.fn(async () => detail) };
  engine.findAssetByDeviceId = vi.fn(async () => null);
  return engine;
}

const callsFor = (table: string, op: string) => h.calls.filter((c) => c.table === table && c.op === op);
const orgMapping: any = { mapping_id: 'org-map-1', client_id: 'client-1' };

beforeEach(() => {
  h.calls.length = 0;
  h.assetByDeviceId = null;
  h.assetById = { asset_id: 'asset-1', client_id: 'client-1', rmm_provider: 'ninjaone', name: 'RECEPTION-PC' };
  h.findDuplicate.mockReset().mockResolvedValue(null);
  h.lockIdentity.mockReset();
  h.recordMacs.mockReset();
  h.isOwnedByOther.mockReset().mockResolvedValue(false);
  h.createdEvent.mockReset();
});

describe('NinjaOne sync engine: create', () => {
  it('inserts the asset, extension and mapping and records MACs when there is no duplicate', async () => {
    const engine = makeEngine();
    const asset = await engine.syncDevice(7);

    expect(h.lockIdentity).toHaveBeenCalledWith(trx, 'tenant-1', 'client-1', 'RECEPTION-PC');
    expect(h.findDuplicate).toHaveBeenCalledWith(trx, 'tenant-1', {
      provider: 'ninjaone',
      clientId: 'client-1',
      displayName: 'RECEPTION-PC',
      macAddresses: deviceMacs,
    });
    expect(callsFor('assets', 'insert')).toHaveLength(1);
    expect(callsFor('workstation_assets', 'insert')).toHaveLength(1);
    expect(callsFor('tenant_external_entity_mappings', 'insert')[0]!.payload).toMatchObject({
      integration_type: 'ninjaone',
      alga_entity_id: 'new-asset',
      external_entity_id: '7',
    });
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'new-asset',
      provider: 'ninjaone',
      macAddresses: deviceMacs,
    });
    expect(asset.asset_id).toBe('new-asset');
  });

  it('links to the duplicate with a mapping only and inserts no asset or extension', async () => {
    h.findDuplicate.mockResolvedValue('dup-asset');
    h.assetById = { asset_id: 'dup-asset', client_id: 'client-1', rmm_provider: 'datto' };
    const engine = makeEngine();

    const asset = await engine.syncDevice(7);

    expect(callsFor('assets', 'insert')).toHaveLength(0);
    expect(callsFor('workstation_assets', 'insert')).toHaveLength(0);
    const mappingInsert = callsFor('tenant_external_entity_mappings', 'insert');
    expect(mappingInsert).toHaveLength(1);
    expect(mappingInsert[0]!.payload).toMatchObject({
      integration_type: 'ninjaone',
      alga_entity_type: 'asset',
      alga_entity_id: 'dup-asset',
      external_entity_id: '7',
      external_realm_id: '5',
    });
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'dup-asset',
      provider: 'ninjaone',
      macAddresses: deviceMacs,
    });
    expect(asset.asset_id).toBe('dup-asset');
  });

  it('does not touch the asset when a concurrent run already created it', async () => {
    h.assetByDeviceId = { asset_id: 'asset-1', rmm_provider: 'ninjaone' };
    const engine = makeEngine();

    const asset = await engine.syncDevice(7);

    expect(h.findDuplicate).not.toHaveBeenCalled();
    expect(callsFor('assets', 'insert')).toHaveLength(0);
    expect(callsFor('tenant_external_entity_mappings', 'insert')).toHaveLength(0);
    expect(asset.asset_id).toBe('asset-1');
  });

  it('skips MAC recording when the detail carried no interface list', async () => {
    const { networkInterfaces: _omit, ...withoutNics } = device;
    const engine = makeEngine(withoutNics);

    await engine.syncDevice(7);

    expect(h.findDuplicate).toHaveBeenCalledWith(trx, 'tenant-1', expect.objectContaining({ macAddresses: undefined }));
    expect(callsFor('assets', 'insert')).toHaveLength(1);
    expect(h.recordMacs).not.toHaveBeenCalled();
  });

  it('processBatch reports a linked device as updated, with no created event', async () => {
    h.findDuplicate.mockResolvedValue('dup-asset');
    h.assetById = { asset_id: 'dup-asset', client_id: 'client-1', rmm_provider: 'datto' };
    const engine = makeEngine();

    const results = await engine.processBatch([device], orgMapping);

    expect(results).toEqual([
      expect.objectContaining({ deviceId: 7, assetId: 'dup-asset', action: 'updated' }),
    ]);
    expect(h.createdEvent).not.toHaveBeenCalled();
  });

  it('processBatch reports a newly inserted asset as created and emits the created event', async () => {
    const engine = makeEngine();

    const results = await engine.processBatch([device], orgMapping);

    expect(results).toEqual([expect.objectContaining({ assetId: 'new-asset', action: 'created' })]);
    expect(h.createdEvent).toHaveBeenCalledTimes(1);
  });
});

describe('NinjaOne sync engine: update', () => {
  const existing = { alga_entity_id: 'asset-1', external_entity_id: '7' };

  it('writes the asset and extension and records MACs when ninjaone owns the asset', async () => {
    const engine = makeEngine();
    engine.findAssetByDeviceId = vi.fn(async () => existing);

    await engine.syncDevice(7);

    expect(h.isOwnedByOther).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'asset-1',
      assetRmmProvider: 'ninjaone',
      provider: 'ninjaone',
    });
    expect(callsFor('assets', 'update')).toHaveLength(1);
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'asset-1',
      provider: 'ninjaone',
      macAddresses: deviceMacs,
    });
  });

  it('only refreshes the mapping and MACs when another RMM owns the asset', async () => {
    h.assetById = { asset_id: 'asset-1', client_id: 'client-1', rmm_provider: 'datto' };
    h.isOwnedByOther.mockResolvedValue(true);
    const engine = makeEngine();
    engine.findAssetByDeviceId = vi.fn(async () => existing);

    await engine.syncDevice(7);

    expect(callsFor('assets', 'update')).toHaveLength(0);
    expect(h.calls.filter((c) => c.table.endsWith('_assets') && c.op !== 'select')).toHaveLength(0);
    expect(callsFor('tenant_external_entity_mappings', 'update')).toHaveLength(1);
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'asset-1',
      provider: 'ninjaone',
      macAddresses: deviceMacs,
    });
  });

  it('processBatch leaves an asset owned by another RMM alone, even with no changes', async () => {
    h.assetById = { asset_id: 'asset-1', client_id: 'client-1', rmm_provider: 'datto', name: 'RECEPTION-PC' };
    h.isOwnedByOther.mockResolvedValue(true);
    const engine = makeEngine();
    engine.findAssetByDeviceId = vi.fn(async () => existing);
    engine.updateAssetLastSeen = vi.fn();

    const results = await engine.processBatch([device], orgMapping);

    expect(results).toEqual([expect.objectContaining({ assetId: 'asset-1', action: 'skipped' })]);
    expect(engine.updateAssetLastSeen).not.toHaveBeenCalled();
    expect(callsFor('assets', 'update')).toHaveLength(0);
    expect(h.recordMacs).toHaveBeenCalledTimes(1);
  });
});

describe('NinjaOne sync engine: deleted devices', () => {
  it('retires an asset ninjaone owns', async () => {
    const engine = makeEngine();

    const retired = await engine.markAssetAsDeleted('asset-1');

    expect(retired).toBe(true);
    expect(callsFor('assets', 'update')[0]!.payload).toMatchObject({ status: 'retired' });
    expect(h.recordMacs).not.toHaveBeenCalled();
  });

  it('keeps an asset another RMM owns, clearing only the ninjaone link and MACs', async () => {
    h.assetById = { rmm_provider: 'datto' };
    h.isOwnedByOther.mockResolvedValue(true);
    const engine = makeEngine();

    const retired = await engine.markAssetAsDeleted('asset-1');

    expect(retired).toBe(false);
    expect(callsFor('assets', 'update')).toHaveLength(0);
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'asset-1',
      provider: 'ninjaone',
      macAddresses: [],
    });
    expect(callsFor('tenant_external_entity_mappings', 'update')[0]!.payload).toMatchObject({
      sync_status: 'error',
    });
  });
});
