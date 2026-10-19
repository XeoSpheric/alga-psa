import { describe, expect, it } from 'vitest';

import {
  mapDattoAlertToEvent,
  mapDattoPriority,
  parseDattoTimestamp,
} from '@alga-psa/integrations/lib/rmm/datto/alertMapper';

const baseAlert = {
  alertUid: 'alert-1',
  priority: 'Critical',
  diagnostics: 'Disk C: is 95% full',
  resolved: false,
  timestamp: 1_776_073_284_000,
  alertContext: {
    '@class': 'perf_disk_usage_ctx',
    diskName: 'C:',
    totalVolume: 500,
    freeSpace: 25,
    unitOfMeasure: 'GB',
  },
  alertMonitorInfo: { sendsEmails: true, createsTicket: false },
  alertSourceInfo: { deviceUid: 'dev-1', deviceName: 'PC-01', siteUid: 'site-1', siteName: 'Acme' },
};

describe('mapDattoAlertToEvent', () => {
  it('T040: maps ids, names, kind, class and sources per FR-6', () => {
    const event = mapDattoAlertToEvent(baseAlert as any, 'tenant_1', 'integration_1');
    expect(event).toEqual(
      expect.objectContaining({
        tenantId: 'tenant_1',
        integrationId: 'integration_1',
        provider: 'datto',
        kind: 'triggered',
        externalAlertId: 'alert-1',
        externalDeviceId: 'dev-1',
        externalOrganizationId: 'site-1',
        deviceName: 'PC-01',
        activityType: 'datto_alert',
        sourceType: 'datto_alert',
        alertClass: 'perf_disk_usage_ctx',
        severity: 'critical',
        occurredAt: new Date(1_776_073_284_000).toISOString(),
      })
    );
    expect(event?.raw).toBe(baseAlert);
    expect(event?.message).toContain('Disk C: is 95% full');
    expect(event?.message).toContain('diskName: C:');
    expect(event?.message).toContain('freeSpace: 25');
  });

  it('returns null without an alertUid', () => {
    expect(mapDattoAlertToEvent({ ...baseAlert, alertUid: '' } as any, 't', 'i')).toBeNull();
    expect(mapDattoAlertToEvent({} as any, 't', 'i')).toBeNull();
    expect(mapDattoAlertToEvent(null, 't', 'i')).toBeNull();
  });

  it('uses kind reset when the alert is resolved', () => {
    expect(mapDattoAlertToEvent({ ...baseAlert, resolved: true } as any, 't', 'i')?.kind).toBe('reset');
  });

  it('maps every Datto priority', () => {
    expect(mapDattoPriority('Critical')).toBe('critical');
    expect(mapDattoPriority('High')).toBe('major');
    expect(mapDattoPriority('Moderate')).toBe('moderate');
    expect(mapDattoPriority('Low')).toBe('minor');
    expect(mapDattoPriority('Information')).toBe('none');
    expect(mapDattoPriority('Unknown')).toBe('none');
    expect(mapDattoPriority(undefined)).toBe('none');
    expect(mapDattoPriority('high')).toBe('major');
  });

  it('parses epoch ms numbers, numeric strings, epoch seconds and ISO; falls back to now', () => {
    const iso = '2026-04-13T09:21:24.000Z';
    const ms = Date.parse(iso);
    expect(parseDattoTimestamp(ms)).toBe(iso);
    expect(parseDattoTimestamp(String(ms))).toBe(iso);
    expect(parseDattoTimestamp(Math.floor(ms / 1000))).toBe(iso);
    expect(parseDattoTimestamp(iso)).toBe(iso);
    const before = Date.now();
    const fallback = Date.parse(parseDattoTimestamp(undefined));
    expect(fallback).toBeGreaterThanOrEqual(before);
    expect(Number.isNaN(Date.parse(parseDattoTimestamp('garbage')))).toBe(false);
  });

  it('strips a package prefix from the context class', () => {
    const event = mapDattoAlertToEvent(
      { ...baseAlert, alertContext: { '@class': 'com.centrastage.alerts.perf_resource_usage_ctx', type: 'CPU' } } as any,
      't',
      'i'
    );
    expect(event?.alertClass).toBe('perf_resource_usage_ctx');
  });

  it('builds a stable conditionIdentity that ignores changing samples but separates objects', () => {
    const a = mapDattoAlertToEvent(baseAlert as any, 't', 'i');
    const sameDiskLaterSample = mapDattoAlertToEvent(
      { ...baseAlert, alertUid: 'alert-2', alertContext: { ...baseAlert.alertContext, freeSpace: 10 } } as any,
      't',
      'i'
    );
    const otherDisk = mapDattoAlertToEvent(
      { ...baseAlert, alertContext: { ...baseAlert.alertContext, diskName: 'D:' } } as any,
      't',
      'i'
    );
    expect(a?.conditionIdentity).toBe('perf_disk_usage_ctx|diskName=C:');
    expect(sameDiskLaterSample?.conditionIdentity).toBe(a?.conditionIdentity);
    expect(otherDisk?.conditionIdentity).not.toBe(a?.conditionIdentity);
  });

  it('includes uid-like alertMonitorInfo fields in the identity and falls back to the class', () => {
    const withMonitor = mapDattoAlertToEvent(
      { ...baseAlert, alertMonitorInfo: { monitorUid: 'mon-9', sendsEmails: true } } as any,
      't',
      'i'
    );
    expect(withMonitor?.conditionIdentity).toContain('monitor.monitorUid=mon-9');

    const classOnly = mapDattoAlertToEvent(
      { alertUid: 'a', alertContext: { '@class': 'online_offline_status_ctx', status: 'OFFLINE' } } as any,
      't',
      'i'
    );
    expect(classOnly?.conditionIdentity).toBe('online_offline_status_ctx');

    const bare = mapDattoAlertToEvent({ alertUid: 'a' } as any, 't', 'i');
    expect(bare?.conditionIdentity).toBeNull();
    expect(bare?.severity).toBe('none');
    expect(bare?.externalDeviceId).toBeNull();
  });

  it('keeps messages under 2000 chars', () => {
    const event = mapDattoAlertToEvent(
      { ...baseAlert, diagnostics: 'x'.repeat(5000) } as any,
      't',
      'i'
    );
    expect(event?.message?.length).toBeLessThanOrEqual(2000);
  });
});
