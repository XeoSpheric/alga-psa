import type { NormalizedRmmAlertEvent, NormalizedRmmAlertSeverity } from '@alga-psa/shared/rmm/alerts';
import type { DattoAlert } from './types';

/** Longest message handed to the pipeline (rmm_alerts.message / ticket text). */
const MAX_MESSAGE_LENGTH = 2000;
/** Longest single context value rendered into the message. */
const MAX_CONTEXT_VALUE_LENGTH = 200;
/** rmm_alerts dedup keys are capped at 255 chars; leave room for the device id. */
const MAX_CONDITION_IDENTITY_LENGTH = 160;

/**
 * alertContext keys that distinguish one firing condition from another of the
 * same class on a device (which disk, which process, which event source ...).
 * Keys that change on every sample (sample, freeSpace, roundtripTime ...) are
 * deliberately absent: they would defeat dedup.
 */
const CONDITION_CONTEXT_KEYS = [
  'type',
  'diskName',
  'processName',
  'logName',
  'source',
  'code',
  'path',
  'objectType',
  'productName',
  'packageName',
  'patchUid',
  'policyUid',
  'displayName',
  'monitorName',
  'monitorInstance',
  'ruleName',
  'OID',
  'oid',
  'instanceName',
  'ipAddress',
] as const;

/**
 * Maps a Datto RMM alert (GET /v2/alert/{uid} or an entry of the open-alerts
 * list) onto the provider-agnostic event the shared pipeline consumes. Returns
 * null when the alert has no uid, since nothing can be correlated without it.
 *
 * Datto alerts carry no stable "condition" id of their own: alertMonitorInfo
 * only exposes notification flags in the v2 spec. The dedup identity is the
 * context class plus the context fields that name the monitored object, plus
 * any uid-like monitor fields a live account happens to return.
 */
export function mapDattoAlertToEvent(
  alert: DattoAlert | null | undefined,
  tenantId: string,
  integrationId: string
): NormalizedRmmAlertEvent | null {
  const externalAlertId = alert?.alertUid != null ? String(alert.alertUid).trim() : '';
  if (!alert || !externalAlertId) return null;

  const source = alert.alertSourceInfo ?? {};
  const alertClass = shortAlertClass(alert.alertContext?.['@class']);

  return {
    tenantId,
    integrationId,
    provider: 'datto',
    kind: alert.resolved === true ? 'reset' : 'triggered',
    externalAlertId,
    externalDeviceId: cleanString(source.deviceUid),
    conditionIdentity: buildConditionIdentity(alert, alertClass),
    activityType: 'datto_alert',
    alertClass,
    sourceType: 'datto_alert',
    severity: mapDattoPriority(alert.priority),
    message: buildMessage(alert, alertClass),
    deviceName: cleanString(source.deviceName),
    externalOrganizationId: cleanString(source.siteUid),
    occurredAt: parseDattoTimestamp(alert.timestamp),
    raw: alert as unknown as Record<string, unknown>,
  };
}

export function mapDattoPriority(priority: unknown): NormalizedRmmAlertSeverity {
  switch (String(priority ?? '').trim().toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'major';
    case 'moderate':
      return 'moderate';
    case 'low':
      return 'minor';
    default:
      // Information, Unknown, or missing.
      return 'none';
  }
}

/**
 * Datto timestamps arrive as epoch milliseconds (number or numeric string);
 * tolerate epoch seconds and ISO strings, and fall back to now rather than let
 * an unparsable value reach the rmm_alerts timestamp column.
 */
export function parseDattoTimestamp(value: unknown): string {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,16}$/.test(value.trim()))) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      const ms = Math.abs(num) < 1e11 ? num * 1000 : num; // ≤ 10 digits → seconds
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  } else if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** 'com.centrastage.x.perf_disk_usage_ctx' -> 'perf_disk_usage_ctx'. */
function shortAlertClass(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  const short = raw.split(/[.$]/).filter(Boolean).pop();
  return short ?? raw;
}

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function buildConditionIdentity(alert: DattoAlert, alertClass: string | null): string | null {
  const parts: string[] = [];
  if (alertClass) parts.push(alertClass);

  const context = (alert.alertContext ?? {}) as Record<string, unknown>;
  for (const key of CONDITION_CONTEXT_KEYS) {
    const value = context[key];
    if (isScalar(value) && String(value).trim()) parts.push(`${key}=${String(value).trim()}`);
  }

  const monitor = (alert.alertMonitorInfo ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(monitor).sort()) {
    if (/(uid|id)$/i.test(key) && isScalar(monitor[key]) && String(monitor[key]).trim()) {
      parts.push(`monitor.${key}=${String(monitor[key]).trim()}`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join('|').slice(0, MAX_CONDITION_IDENTITY_LENGTH);
}

function renderContextValue(value: unknown): string | null {
  if (isScalar(value)) {
    const text = String(value).trim();
    return text ? text.slice(0, MAX_CONTEXT_VALUE_LENGTH) : null;
  }
  if (Array.isArray(value)) {
    const items = value.filter(isScalar).map((v) => String(v).trim()).filter(Boolean);
    return items.length ? items.join(', ').slice(0, MAX_CONTEXT_VALUE_LENGTH) : null;
  }
  return null;
}

/** Human-readable text: Datto's diagnostics followed by the context details. */
function buildMessage(alert: DattoAlert, alertClass: string | null): string | null {
  const diagnostics = cleanString(alert.diagnostics);

  const details: string[] = [];
  const context = (alert.alertContext ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(context)) {
    if (key === '@class') continue;
    const rendered = renderContextValue(value);
    if (rendered) details.push(`${key}: ${rendered}`);
  }

  const pieces: string[] = [];
  if (diagnostics) pieces.push(diagnostics);
  if (details.length) pieces.push(details.join('; '));
  if (pieces.length === 0 && alertClass) pieces.push(`Datto RMM alert (${alertClass})`);
  if (pieces.length === 0) return null;

  return pieces.join('\n').slice(0, MAX_MESSAGE_LENGTH);
}
