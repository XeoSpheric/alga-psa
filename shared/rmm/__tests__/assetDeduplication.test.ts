import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cross-RMM dedup: MAC/name normalization, the match contract (exactly one
 * candidate on name + client + MAC), and the per-provider MAC set. The SQL
 * itself is checked against Postgres separately; here the connection is a stub.
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const calls: Array<{ table: string; op: string; args: any[] }> = [];

  const builder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const qb: any = {
      where(obj: Row) {
        filters.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v));
        return qb;
      },
      whereNotIn(col: string, values: any[]) {
        filters.push((r) => !values.includes(r[col]));
        return qb;
      },
      async delete() {
        const list = (tables[table] ??= []);
        const keep = list.filter((r) => !filters.every((f) => f(r)));
        const removed = list.length - keep.length;
        tables[table] = keep;
        calls.push({ table, op: 'delete', args: [] });
        return removed;
      },
      async first(..._cols: string[]) {
        return (tables[table] ?? []).find((r) => filters.every((f) => f(r)));
      },
      insert(rows: Row[]) {
        return {
          onConflict: (cols: string[]) => ({
            merge: async (patch: Row) => {
              const list = (tables[table] ??= []);
              for (const row of rows) {
                const existing = list.find((r) => cols.every((c) => r[c] === row[c]));
                if (existing) Object.assign(existing, patch);
                else list.push({ ...row, ...patch });
              }
              calls.push({ table, op: 'upsert', args: [rows] });
            },
          }),
        };
      },
    };
    return qb;
  };

  return { tables, calls, builder };
});

vi.mock('@alga-psa/db', () => ({
  tenantDb: (_conn: any, tenant: string) => ({
    table: (table: string) => h.builder(table).where({ tenant }),
  }),
}));

import {
  findDuplicateAssetForRmmDevice,
  isAssetOwnedByAnotherRmm,
  normalizeAssetNameForMatch,
  normalizeMacAddress,
  normalizeMacAddresses,
  recordAssetMacAddresses,
} from '../assetDeduplication';

const conn = (rows: Array<{ asset_id: string }> = []) => {
  const raw = vi.fn(async (_sql: string, _bindings: any[]) => ({ rows }));
  return { raw, fn: { now: () => 'NOW' } } as any;
};

describe('normalizeMacAddress', () => {
  it('accepts the common notations and returns aa:bb:cc:dd:ee:ff', () => {
    for (const value of ['AA:BB:CC:DD:EE:01', 'aa-bb-cc-dd-ee-01', 'aabb.ccdd.ee01', 'aabbccddee01', ' AA BB CC DD EE 01 ']) {
      expect(normalizeMacAddress(value)).toBe('aa:bb:cc:dd:ee:01');
    }
  });

  it('rejects values that do not identify one machine', () => {
    expect(normalizeMacAddress('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMacAddress('FF:FF:FF:FF:FF:FF')).toBeNull();
    // Multicast: low bit of the first octet set.
    expect(normalizeMacAddress('01:00:5e:00:00:fb')).toBeNull();
    // Microsoft loopback adapter, identical everywhere.
    expect(normalizeMacAddress('02-00-4C-4F-4F-50')).toBeNull();
  });

  it('rejects malformed input instead of salvaging hex out of it', () => {
    expect(normalizeMacAddress('aa:bb:cc:dd:ee')).toBeNull();
    expect(normalizeMacAddress('aa:bb:cc:dd:ee:01:02')).toBeNull();
    expect(normalizeMacAddress('MAC aa:bb:cc:dd:ee:01')).toBeNull();
    expect(normalizeMacAddress('gg:bb:cc:dd:ee:01')).toBeNull();
    expect(normalizeMacAddress(null)).toBeNull();
    expect(normalizeMacAddress(42)).toBeNull();
  });

  it('keeps locally administered unicast addresses (VMs, many Wi-Fi chips)', () => {
    expect(normalizeMacAddress('02:15:5d:01:02:03')).toBe('02:15:5d:01:02:03');
  });
});

describe('normalizeMacAddresses / normalizeAssetNameForMatch', () => {
  it('de-duplicates, drops junk and sorts', () => {
    expect(normalizeMacAddresses(['AA:BB:CC:DD:EE:02', 'aa-bb-cc-dd-ee-01', 'aabbccddee02', '', null, '00:00:00:00:00:00']))
      .toEqual(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
    expect(normalizeMacAddresses(undefined)).toEqual([]);
  });

  it('matches the SQL name key: trimmed, whitespace collapsed, lower-cased', () => {
    expect(normalizeAssetNameForMatch('  Front   Desk\tPC ')).toBe('front desk pc');
    expect(normalizeAssetNameForMatch(undefined)).toBe('');
  });
});

describe('findDuplicateAssetForRmmDevice', () => {
  const identity = { provider: 'datto', clientId: 'client-1', displayName: ' Front-Desk ', macAddresses: ['AA:BB:CC:DD:EE:01'] };

  it('returns the single candidate, querying on tenant, client, name key, MACs and provider', async () => {
    const c = conn([{ asset_id: 'asset-1' }]);
    expect(await findDuplicateAssetForRmmDevice(c, 'tenant-1', identity)).toBe('asset-1');
    expect(c.raw.mock.calls[0][1]).toEqual(['tenant-1', 'client-1', 'front-desk', ['aa:bb:cc:dd:ee:01'], 'datto']);
    // Requires all three: a shared MAC, the client and the name.
    const sql = c.raw.mock.calls[0][0] as string;
    expect(sql).toMatch(/a\.client_id = \?/);
    expect(sql).toMatch(/m\.mac_address = ANY/);
    expect(sql).toMatch(/lower\(regexp_replace\(trim\(a\.name\)/);
  });

  it('refuses to guess between two candidates', async () => {
    expect(await findDuplicateAssetForRmmDevice(conn([{ asset_id: 'a' }, { asset_id: 'b' }]), 'tenant-1', identity)).toBeNull();
  });

  it('does not query without a usable MAC, a name or a client', async () => {
    for (const partial of [
      { macAddresses: ['00:00:00:00:00:00'] },
      { macAddresses: [] },
      { displayName: '   ' },
      { clientId: '' },
    ]) {
      const c = conn([{ asset_id: 'asset-1' }]);
      expect(await findDuplicateAssetForRmmDevice(c, 'tenant-1', { ...identity, ...partial })).toBeNull();
      expect(c.raw).not.toHaveBeenCalled();
    }
  });
});

describe('recordAssetMacAddresses', () => {
  beforeEach(() => {
    for (const key of Object.keys(h.tables)) delete h.tables[key];
    h.calls.length = 0;
  });

  const macsOf = (provider: string) =>
    (h.tables.asset_mac_addresses ?? []).filter((r) => r.provider === provider).map((r) => r.mac_address).sort();

  it('replaces only this provider’s set for the asset', async () => {
    h.tables.asset_mac_addresses = [
      { tenant: 't', asset_id: 'a1', mac_address: 'aa:bb:cc:dd:ee:01', provider: 'datto' },
      { tenant: 't', asset_id: 'a1', mac_address: 'aa:bb:cc:dd:ee:09', provider: 'datto' },
      { tenant: 't', asset_id: 'a1', mac_address: 'aa:bb:cc:dd:ee:09', provider: 'ninjaone' },
    ];

    await recordAssetMacAddresses(conn(), 't', { assetId: 'a1', provider: 'datto', macAddresses: ['AA-BB-CC-DD-EE-01', 'aa:bb:cc:dd:ee:02'] });

    expect(macsOf('datto')).toEqual(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
    expect(macsOf('ninjaone')).toEqual(['aa:bb:cc:dd:ee:09']);
  });

  it('clears this provider’s set on an empty list', async () => {
    h.tables.asset_mac_addresses = [{ tenant: 't', asset_id: 'a1', mac_address: 'aa:bb:cc:dd:ee:01', provider: 'datto' }];

    await recordAssetMacAddresses(conn(), 't', { assetId: 'a1', provider: 'datto', macAddresses: [] });

    expect(macsOf('datto')).toEqual([]);
    expect(h.calls.map((c) => c.op)).toEqual(['delete']);
  });
});

describe('isAssetOwnedByAnotherRmm', () => {
  beforeEach(() => {
    for (const key of Object.keys(h.tables)) delete h.tables[key];
  });

  it('is false for an unowned asset or one this provider owns', async () => {
    expect(await isAssetOwnedByAnotherRmm(conn(), 't', { assetId: 'a1', assetRmmProvider: null, provider: 'datto' })).toBe(false);
    expect(await isAssetOwnedByAnotherRmm(conn(), 't', { assetId: 'a1', assetRmmProvider: 'datto', provider: 'datto' })).toBe(false);
  });

  it('is true only while the owning provider is still mapped to the asset', async () => {
    const args = { assetId: 'a1', assetRmmProvider: 'ninjaone', provider: 'datto' };
    expect(await isAssetOwnedByAnotherRmm(conn(), 't', args)).toBe(false);

    h.tables.tenant_external_entity_mappings = [
      { tenant: 't', id: 'm1', integration_type: 'ninjaone', alga_entity_type: 'asset', alga_entity_id: 'a1' },
    ];
    expect(await isAssetOwnedByAnotherRmm(conn(), 't', args)).toBe(true);
  });
});
