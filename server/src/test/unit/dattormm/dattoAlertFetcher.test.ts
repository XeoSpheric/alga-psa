import { beforeEach, describe, expect, it, vi } from 'vitest';

let client: { listOpenAlerts: ReturnType<typeof vi.fn> } | null;
let mappingRows: Array<Record<string, any>>;
const mappingQuery = {
  where: vi.fn(),
  whereNotNull: vi.fn(),
  select: vi.fn(),
};

vi.mock('@alga-psa/db', () => ({
  createTenantKnex: vi.fn(async () => ({ knex: {} })),
  tenantDb: () => ({ table: () => mappingQuery }),
}));

vi.mock('@alga-psa/integrations/lib/rmm/datto/buildClient', () => ({
  buildDattoClientForTenant: vi.fn(async () => client),
}));

const registerRmmAlertFetcher = vi.fn();
vi.mock('@alga-psa/shared/rmm/alerts', async () => {
  const actual: any = await vi.importActual('@alga-psa/shared/rmm/alerts');
  return { ...actual, registerRmmAlertFetcher };
});

const alert = (uid: string, siteUid: string | null, extra: Record<string, unknown> = {}) => ({
  alertUid: uid,
  priority: 'High',
  diagnostics: `diag ${uid}`,
  timestamp: 1_776_073_284_000,
  alertContext: { '@class': 'online_offline_status_ctx' },
  alertSourceInfo: { deviceUid: `dev-${uid}`, deviceName: `host-${uid}`, siteUid },
  ...extra,
});

describe('dattoRmmAlertFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mappingRows = [{ external_organization_id: 'site-1' }, { external_organization_id: 'site-2' }];
    mappingQuery.where.mockReturnValue(mappingQuery);
    mappingQuery.whereNotNull.mockReturnValue(mappingQuery);
    mappingQuery.select.mockImplementation(async () => mappingRows);
    client = {
      listOpenAlerts: vi.fn(async () => [
        alert('a1', 'site-1'),
        alert('a2', 'site-unmapped'),
        alert('a3', 'site-2', { resolved: true }),
        alert('a4', 'site-2'),
        alert('a5', null),
      ]),
    };
  });

  it('T041: keeps only open alerts for mapped sites and maps them as triggered events', async () => {
    const { dattoRmmAlertFetcher } = await import('@alga-psa/integrations/lib/rmm/datto/alertFetcher');

    const events = await dattoRmmAlertFetcher.fetchActiveAlerts({ tenantId: 'tenant_1', integrationId: 'int_1' });

    expect(events.map((e) => e.externalAlertId)).toEqual(['a1', 'a4']);
    expect(events[0]).toEqual(
      expect.objectContaining({
        provider: 'datto',
        kind: 'triggered',
        tenantId: 'tenant_1',
        integrationId: 'int_1',
        externalOrganizationId: 'site-1',
        severity: 'major',
      })
    );
    expect(mappingQuery.where).toHaveBeenCalledWith({ integration_id: 'int_1' });
    expect(mappingQuery.whereNotNull).toHaveBeenCalledWith('client_id');
  });

  it('returns nothing and skips the Datto call when no site is mapped', async () => {
    mappingRows = [];
    const { dattoRmmAlertFetcher } = await import('@alga-psa/integrations/lib/rmm/datto/alertFetcher');
    expect(await dattoRmmAlertFetcher.fetchActiveAlerts({ tenantId: 't', integrationId: 'i' })).toEqual([]);
    expect(client!.listOpenAlerts).not.toHaveBeenCalled();
  });

  it('returns nothing when the tenant has no usable Datto client', async () => {
    client = null;
    const { dattoRmmAlertFetcher } = await import('@alga-psa/integrations/lib/rmm/datto/alertFetcher');
    expect(await dattoRmmAlertFetcher.fetchActiveAlerts({ tenantId: 't', integrationId: 'i' })).toEqual([]);
  });

  it('registers itself under the datto provider as a module side effect', async () => {
    vi.resetModules();
    const mod = await import('@alga-psa/integrations/lib/rmm/datto/alertFetcher');
    expect(registerRmmAlertFetcher).toHaveBeenCalledWith('datto', mod.dattoRmmAlertFetcher);
  });
});
