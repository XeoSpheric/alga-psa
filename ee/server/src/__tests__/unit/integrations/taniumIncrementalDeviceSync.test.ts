import { describe, expect, it } from 'vitest';
import { mapEndpointToSnapshot, taniumEndpointChangedSince, taniumEndpointMacAddresses } from '../../../lib/integrations/tanium/sync/deviceSyncEngine';

/**
 * Tanium's incremental window.
 *
 * listEndpoints() accepts only a computerGroupId — no time filter — so
 * "incremental" is the same page walk filtered on each endpoint's lastSeen.
 * Getting this wrong is silent in both directions: too strict and devices
 * quietly stop updating, too loose and the run costs the same as a full sweep.
 */

const SINCE = new Date('2026-08-13T09:00:00.000Z');

describe('taniumEndpointChangedSince', () => {
  it('includes an endpoint seen after the cursor', () => {
    expect(taniumEndpointChangedSince({ lastSeen: '2026-08-13T10:00:00.000Z' }, SINCE)).toBe(true);
  });

  it('excludes an endpoint last seen before the cursor', () => {
    expect(taniumEndpointChangedSince({ lastSeen: '2026-08-01T10:00:00.000Z' }, SINCE)).toBe(false);
  });

  it('treats an endpoint seen exactly at the cursor as changed', () => {
    // Inclusive on purpose: an exclusive bound drops an endpoint that changed
    // in the same instant the previous run recorded as its cursor.
    expect(taniumEndpointChangedSince({ lastSeen: '2026-08-13T09:00:00.000Z' }, SINCE)).toBe(true);
  });

  it('always considers an endpoint with no lastSeen', () => {
    // Absent data must not exclude a device from every incremental run forever.
    expect(taniumEndpointChangedSince({ lastSeen: null }, SINCE)).toBe(true);
    expect(taniumEndpointChangedSince({}, SINCE)).toBe(true);
  });

  it('always considers an endpoint whose lastSeen is unparseable', () => {
    expect(taniumEndpointChangedSince({ lastSeen: 'not a date' }, SINCE)).toBe(true);
  });

  it('includes every endpoint when no cursor is given (full sync unchanged)', () => {
    expect(taniumEndpointChangedSince({ lastSeen: '2020-01-01T00:00:00.000Z' }, undefined)).toBe(true);
  });
});

describe('taniumEndpointMacAddresses', () => {
  it('unions the flat list with adapter MACs', () => {
    expect(
      taniumEndpointMacAddresses({
        id: 'e1',
        name: 'PC',
        metadata: {
          macAddresses: ['AA:BB:CC:DD:EE:01'],
          networkAdapters: [{ macAddress: 'aa:bb:cc:dd:ee:02' }, { name: 'no mac' }, null],
        },
      })
    ).toEqual(['AA:BB:CC:DD:EE:01', 'aa:bb:cc:dd:ee:02']);
  });

  it('reads either source alone, and reports [] for a real read that found none', () => {
    expect(taniumEndpointMacAddresses({ id: 'e1', name: 'PC', metadata: { networkAdapters: [{ macAddress: '00:11:22:33:44:55' }] } })).toEqual([
      '00:11:22:33:44:55',
    ]);
    expect(taniumEndpointMacAddresses({ id: 'e1', name: 'PC', metadata: { macAddresses: [], networkAdapters: [] } })).toEqual([]);
  });

  it('is undefined when neither was read (aged-out asset fallback), so recorded MACs survive', () => {
    expect(taniumEndpointMacAddresses({ id: 'e1', name: 'PC' })).toBeUndefined();
    expect(taniumEndpointMacAddresses({ id: 'e1', name: 'PC', metadata: { model: 'x' } })).toBeUndefined();
  });

  it('is carried onto the snapshot', () => {
    const snapshot = mapEndpointToSnapshot({
      integrationId: 'int-1',
      scopeId: 'grp',
      endpoint: { id: 'e1', name: 'PC', metadata: { macAddresses: ['aa:bb:cc:dd:ee:01'] } },
    });
    expect(snapshot.macAddresses).toEqual(['aa:bb:cc:dd:ee:01']);
  });
});
