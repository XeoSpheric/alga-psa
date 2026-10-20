import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Cross-RMM asset dedup in the Temporal NinjaOne sync worker (the parallel
 * writer to the server's sync engine). A device another RMM already created an
 * asset for is linked with a ninjaone mapping only, and an asset owned by
 * another RMM is never written by NinjaOne. The shared helpers are mocked; what
 * is under test is that the worker calls them and acts on the answer.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: any; wheres: any[]; first?: boolean }>,
  assetByDeviceId: null as any,
  assetById: null as any,
  existingMapping: null as any,
  mappingRows: [] as any[],
  devices: [] as any[],
  detail: null as any,
  findDuplicate: vi.fn(),
  lockIdentity: vi.fn(),
  recordMacs: vi.fn(),
  isOwnedByOther: vi.fn(),
  publishEvent: vi.fn(),
}));

const orgMapping = { mapping_id: 'org-map-1', client_id: 'client-1', external_organization_id: '5', external_organization_name: 'Org' };

function respond(state: { table: string; op: string; wheres: any[]; first?: boolean }) {
  const hasWhere = (key: string) => state.wheres.some((w) => w && typeof w === 'object' && key in w);
  switch (state.table) {
    case 'assets':
      if (state.op === 'insert') return [{ asset_id: 'new-asset', client_id: 'client-1', name: 'RECEPTION-PC' }];
      if (state.op === 'update') return [{ asset_id: 'asset-1', client_id: 'client-1' }];
      return hasWhere('rmm_device_id') ? h.assetByDeviceId : h.assetById;
    case 'rmm_organization_mappings':
      if (state.op !== 'select') return [];
      return state.first ? orgMapping : [orgMapping];
    case 'tenant_external_entity_mappings':
      if (state.op !== 'select') return [];
      return state.first ? h.existingMapping : h.mappingRows;
    default:
      return state.op === 'select' ? (state.first ? undefined : []) : [];
  }
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
    whereNotNull: () => b,
    whereIn: () => b,
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
const fakeKnex = { raw: vi.fn(), fn: { now: () => 'now' } };

vi.mock('@alga-psa/db/admin.js', () => ({
  getAdminConnection: vi.fn(async () => fakeKnex),
  refreshAdminConnection: vi.fn(async () => fakeKnex),
  withAdminTransactionRetryReadOnly: async (cb: (t: unknown) => unknown) => cb(trx),
  retryOnAdminReadOnly: async (cb: () => unknown) => cb(),
}));
vi.mock('@alga-psa/db', () => ({
  tenantDb: () => ({ table: (name: string) => makeBuilder(name), tenantJoin: vi.fn() }),
  isReadOnlyError: () => false,
}));
vi.mock('@alga-psa/core/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('@alga-psa/workflow-streams', () => ({
  getRedisStreamClient: () => ({ publishEvent: h.publishEvent }),
}));
vi.mock('@ee/lib/integrations/ninjaone/ninjaOneClient', () => ({
  createNinjaOneClient: vi.fn(async () => ({
    getDevice: vi.fn(async () => h.detail),
    getDevicesByOrganization: vi.fn(async () => h.devices),
  })),
}));
vi.mock('@alga-psa/shared/rmm/assetDeduplication', () => ({
  findDuplicateAssetForRmmDevice: h.findDuplicate,
  lockAssetIdentity: h.lockIdentity,
  recordAssetMacAddresses: h.recordMacs,
  isAssetOwnedByAnotherRmm: h.isOwnedByOther,
}));

const { syncNinjaOneDeviceActivity, syncNinjaOneDevicesFullActivity } = await import('../ninjaone-sync-activities');

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
const input = { tenantId: 'tenant-1', integrationId: 'integration-1' };

const callsFor = (table: string, op: string) => h.calls.filter((c) => c.table === table && c.op === op);

beforeEach(() => {
  h.calls.length = 0;
  h.assetByDeviceId = null;
  h.assetById = { asset_id: 'asset-1', client_id: 'client-1', rmm_provider: 'ninjaone', name: 'RECEPTION-PC' };
  h.existingMapping = null;
  h.mappingRows = [];
  h.devices = [];
  h.detail = device;
  h.findDuplicate.mockReset().mockResolvedValue(null);
  h.lockIdentity.mockReset();
  h.recordMacs.mockReset();
  h.isOwnedByOther.mockReset().mockResolvedValue(false);
  h.publishEvent.mockReset();
});

describe('NinjaOne Temporal worker: create', () => {
  it('inserts the asset, extension and mapping and records MACs when there is no duplicate', async () => {
    const asset = await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

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

    const asset = await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

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

    const asset = await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

    expect(h.findDuplicate).not.toHaveBeenCalled();
    expect(callsFor('assets', 'insert')).toHaveLength(0);
    expect(callsFor('tenant_external_entity_mappings', 'insert')).toHaveLength(0);
    expect(asset.asset_id).toBe('asset-1');
  });

  it('skips MAC recording when the detail carried no interface list', async () => {
    const { networkInterfaces: _omit, ...withoutNics } = device;
    h.detail = withoutNics;

    await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

    expect(callsFor('assets', 'insert')).toHaveLength(1);
    expect(h.recordMacs).not.toHaveBeenCalled();
  });

  it('a full sync counts a linked device as updated, not created', async () => {
    h.findDuplicate.mockResolvedValue('dup-asset');
    h.assetById = { asset_id: 'dup-asset', client_id: 'client-1', rmm_provider: 'datto' };
    h.devices = [device];

    const result = await syncNinjaOneDevicesFullActivity(input);

    expect(result).toMatchObject({ items_created: 0, items_updated: 1, items_failed: 0 });
    expect(callsFor('assets', 'insert')).toHaveLength(0);
    expect(h.publishEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: 'RMM_DEVICE_CREATED' }));
  });
});

describe('NinjaOne Temporal worker: update', () => {
  beforeEach(() => {
    h.existingMapping = { alga_entity_id: 'asset-1', external_entity_id: '7' };
  });

  it('writes the asset and records MACs when ninjaone owns the asset', async () => {
    await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

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

    await syncNinjaOneDeviceActivity({ ...input, deviceId: 7 });

    expect(callsFor('assets', 'update')).toHaveLength(0);
    expect(h.calls.filter((c) => c.table.endsWith('_assets') && c.op !== 'select')).toHaveLength(0);
    expect(callsFor('tenant_external_entity_mappings', 'update')).toHaveLength(1);
    expect(h.recordMacs).toHaveBeenCalledWith(trx, 'tenant-1', {
      assetId: 'asset-1',
      provider: 'ninjaone',
      macAddresses: deviceMacs,
    });
  });

  it('a full sync leaves an asset owned by another RMM alone, even with no changes', async () => {
    h.assetById = { asset_id: 'asset-1', client_id: 'client-1', rmm_provider: 'datto', name: 'RECEPTION-PC' };
    h.isOwnedByOther.mockResolvedValue(true);
    h.devices = [device];

    const result = await syncNinjaOneDevicesFullActivity(input);

    expect(result).toMatchObject({ items_updated: 0, items_failed: 0 });
    expect(callsFor('assets', 'update')).toHaveLength(0);
    expect(h.recordMacs).toHaveBeenCalledTimes(1);
  });
});

describe('NinjaOne Temporal worker: deleted devices', () => {
  beforeEach(() => {
    // The device is gone from NinjaOne but still mapped.
    h.devices = [];
    h.mappingRows = [{ alga_entity_id: 'asset-1', external_entity_id: '7' }];
  });

  it('marks an asset ninjaone owns inactive', async () => {
    const result = await syncNinjaOneDevicesFullActivity(input);

    expect(result.items_deleted).toBe(1);
    expect(callsFor('assets', 'update')[0]!.payload).toMatchObject({ status: 'inactive' });
  });

  it('keeps an asset another RMM owns, clearing only the ninjaone link and MACs', async () => {
    h.assetById = { rmm_provider: 'datto' };
    h.isOwnedByOther.mockResolvedValue(true);

    const result = await syncNinjaOneDevicesFullActivity(input);

    expect(result.items_deleted).toBe(0);
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
