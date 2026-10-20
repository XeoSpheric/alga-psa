/**
 * Cross-RMM asset deduplication against a real database.
 *
 * The unit tests stub the connection, so they cannot show that the migration
 * creates asset_mac_addresses with its checks, that the match query runs and
 * uses name + client + MAC together, or that the shared ingest service links a
 * second RMM's device instead of creating a second asset. That is what this
 * covers.
 *
 * Naming: `.db.test.ts` — skipped by the CI unit-coverage job (no database),
 * run by the integration workflow.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';

import { createTestDbConnection } from '../../../../test-utils/dbConfig';
import { describeWithDb } from '../../../../test-utils/requireDb';
import { createClient, createTenant } from '../../../../test-utils/testDataFactory';
import { findDuplicateAssetForRmmDevice } from '@alga-psa/shared/rmm/assetDeduplication';
import { ingestNormalizedRmmDeviceSnapshot } from '@alga-psa/shared/rmm/sharedAssetIngestionService';
import type { NormalizedRmmExternalDeviceSnapshot } from '@alga-psa/shared/rmm/contracts';

const describeDb = await describeWithDb();

describeDb('cross-RMM asset deduplication (db)', () => {
  let db: Knex;
  let tenant: string;
  let clientId: string;
  let otherClientId: string;

  const snapshot = (overrides: Partial<NormalizedRmmExternalDeviceSnapshot>): NormalizedRmmExternalDeviceSnapshot => ({
    provider: 'datto',
    integrationId: randomUUID(),
    externalDeviceId: randomUUID(),
    externalScopeId: 'site-1',
    lifecycleState: 'active',
    assetType: 'workstation',
    displayName: 'FRONT-DESK',
    serialNumber: 'SN-1',
    agentStatus: 'online',
    lastSeenAt: new Date().toISOString(),
    extension: { osType: 'Windows', osVersion: '11' },
    metadata: {},
    ...overrides,
  });

  // The scope mapping is passed in, so no rmm_integrations rows are needed.
  const ingest = (snap: NormalizedRmmExternalDeviceSnapshot, client = clientId) =>
    ingestNormalizedRmmDeviceSnapshot({
      tenant,
      snapshot: snap,
      resolvedClientId: client,
      scopeMapping: { client_id: client, contact_assignment_mode: 'off' },
      knex: db,
    });

  const assetsOf = (client = clientId) => db('assets').where({ tenant, client_id: client }).select('*');
  const macsOf = (assetId: string) =>
    db('asset_mac_addresses').where({ tenant, asset_id: assetId }).orderBy(['provider', 'mac_address']).select('provider', 'mac_address');

  beforeAll(async () => {
    process.env.APP_ENV = process.env.APP_ENV || 'test';
    db = await createTestDbConnection({ databaseName: 'test_db_asset_dedup', runSeeds: false });
  }, 600_000);

  afterAll(async () => {
    await db?.destroy();
  });

  beforeEach(async () => {
    tenant = await createTenant(db, `Dedup ${randomUUID().slice(0, 8)}`);
    clientId = await createClient(db, tenant, 'Acme Dental');
    otherClientId = await createClient(db, tenant, 'Globex');
  });

  it('rejects a MAC that is not in canonical form', async () => {
    const created = await ingest(snapshot({ macAddresses: ['AA-BB-CC-DD-EE-01'] }));
    await expect(
      db('asset_mac_addresses').insert({ tenant, asset_id: created.assetId, mac_address: 'AA-BB-CC-DD-EE-01', provider: 'x' })
    ).rejects.toThrow(/asset_mac_addresses_format_check/);
  });

  it('links the same machine reported by a second RMM to the first one’s asset', async () => {
    const first = await ingest(snapshot({ macAddresses: ['AA-BB-CC-DD-EE-01', '00:00:00:00:00:00'] }));
    expect(first.action).toBe('created');
    expect(await macsOf(first.assetId!)).toEqual([{ provider: 'datto', mac_address: 'aa:bb:cc:dd:ee:01' }]);

    const second = await ingest(snapshot({
      provider: 'levelio',
      displayName: '  front-desk ',
      serialNumber: 'SN-OTHER',
      macAddresses: ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:77'],
    }));

    expect(second).toMatchObject({ action: 'linked', assetId: first.assetId, ownership: 'secondary' });
    const assets = await assetsOf();
    expect(assets).toHaveLength(1);
    // The owner's data stands.
    expect(assets[0]).toMatchObject({ rmm_provider: 'datto', name: 'FRONT-DESK', serial_number: 'SN-1' });
    expect(await macsOf(first.assetId!)).toEqual([
      { provider: 'datto', mac_address: 'aa:bb:cc:dd:ee:01' },
      { provider: 'levelio', mac_address: 'aa:bb:cc:dd:ee:01' },
      { provider: 'levelio', mac_address: 'aa:bb:cc:dd:ee:77' },
    ]);
    const mappings = await db('tenant_external_entity_mappings')
      .where({ tenant, alga_entity_type: 'asset', alga_entity_id: first.assetId })
      .orderBy('integration_type')
      .select('integration_type');
    expect(mappings.map((m) => m.integration_type)).toEqual(['datto', 'levelio']);
  });

  it('keeps the second RMM from overwriting the asset on later syncs', async () => {
    const first = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    const levelDevice = randomUUID();
    await ingest(snapshot({ provider: 'levelio', externalDeviceId: levelDevice, macAddresses: ['aa:bb:cc:dd:ee:01'] }));

    const update = await ingest(snapshot({
      provider: 'levelio',
      externalDeviceId: levelDevice,
      displayName: 'RENAMED-BY-LEVEL',
      macAddresses: ['aa:bb:cc:dd:ee:01'],
    }));

    expect(update).toMatchObject({ action: 'updated', assetId: first.assetId, ownership: 'secondary' });
    const [asset] = await assetsOf();
    expect(asset).toMatchObject({ name: 'FRONT-DESK', rmm_provider: 'datto' });
  });

  it('needs all three of name, client and MAC', async () => {
    await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));

    // Same name and client, different MAC: a different machine.
    expect((await ingest(snapshot({ provider: 'levelio', macAddresses: ['aa:bb:cc:dd:ee:02'] }))).action).toBe('created');
    // Same MAC and client, different name.
    expect((await ingest(snapshot({ provider: 'tanium', displayName: 'BACK-OFFICE', macAddresses: ['aa:bb:cc:dd:ee:01'] }))).action).toBe('created');
    // Same name and MAC at another client.
    expect((await ingest(snapshot({ provider: 'tactical', macAddresses: ['aa:bb:cc:dd:ee:01'] }), otherClientId)).action).toBe('created');
    // No MACs reported: never deduplicated.
    expect((await ingest(snapshot({ provider: 'huntress' }))).action).toBe('created');
  });

  it('does not fold a second device of the same RMM into an asset it already has', async () => {
    const first = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    // A re-imaged machine enrolled again in the same RMM under a new device id.
    const again = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    expect(again.action).toBe('created');
    expect(again.assetId).not.toBe(first.assetId);
  });

  it('creates rather than guesses when two assets match', async () => {
    await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    // Another FRONT-DESK at the same client (different MAC, so its own asset)...
    const twin = await ingest(snapshot({ provider: 'ninjaone', macAddresses: ['aa:bb:cc:dd:ee:09'] }));
    expect(twin.action).toBe('created');
    // ...that also carries the first one's MAC.
    await db('asset_mac_addresses').insert({ tenant, asset_id: twin.assetId, mac_address: 'aa:bb:cc:dd:ee:01', provider: 'ninjaone' });

    expect(await findDuplicateAssetForRmmDevice(db, tenant, {
      provider: 'levelio',
      clientId,
      displayName: 'FRONT-DESK',
      macAddresses: ['aa:bb:cc:dd:ee:01'],
    })).toBeNull();
    expect((await ingest(snapshot({ provider: 'levelio', macAddresses: ['aa:bb:cc:dd:ee:01'] }))).action).toBe('created');
  });

  it('does not link to a retired asset', async () => {
    const first = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    await db('assets').where({ tenant, asset_id: first.assetId }).update({ status: 'retired' });

    expect((await ingest(snapshot({ provider: 'levelio', macAddresses: ['aa:bb:cc:dd:ee:01'] }))).action).toBe('created');
  });

  it('takes over an asset whose owning RMM is no longer mapped', async () => {
    const first = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    const levelDevice = randomUUID();
    await ingest(snapshot({ provider: 'levelio', externalDeviceId: levelDevice, macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    // Datto integration removed: its mapping goes away.
    await db('tenant_external_entity_mappings').where({ tenant, integration_type: 'datto' }).delete();

    const update = await ingest(snapshot({ provider: 'levelio', externalDeviceId: levelDevice, displayName: 'FRONT-DESK-2', macAddresses: ['aa:bb:cc:dd:ee:01'] }));

    expect(update).toMatchObject({ action: 'updated', assetId: first.assetId, ownership: 'primary' });
    const [asset] = await assetsOf();
    expect(asset).toMatchObject({ rmm_provider: 'levelio', rmm_device_id: levelDevice, name: 'FRONT-DESK-2' });
  });

  it('does not retire an asset another RMM owns when the second agent goes away', async () => {
    const first = await ingest(snapshot({ macAddresses: ['aa:bb:cc:dd:ee:01'] }));
    const levelDevice = randomUUID();
    await ingest(snapshot({ provider: 'levelio', externalDeviceId: levelDevice, macAddresses: ['aa:bb:cc:dd:ee:01'] }));

    const removed = await ingest(snapshot({ provider: 'levelio', externalDeviceId: levelDevice, lifecycleState: 'deleted' }));

    expect(removed).toMatchObject({ action: 'marked_deleted', ownership: 'secondary' });
    const [asset] = await assetsOf();
    expect(asset.status).toBe('active');
    expect(await macsOf(first.assetId!)).toEqual([{ provider: 'datto', mac_address: 'aa:bb:cc:dd:ee:01' }]);
  });
});
