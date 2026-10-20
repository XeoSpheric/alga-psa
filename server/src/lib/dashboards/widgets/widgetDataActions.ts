'use server';

import { createTenantKnex } from '@alga-psa/db';
import { withAuth, hasPermission } from '@alga-psa/auth';
import logger from '@alga-psa/core/logger';
import { getWidgetDefinition } from './definitions';
import { WIDGET_LOADERS } from './loaders';
import type { WidgetDataResult } from './dataTypes';

/**
 * The single entry point for widget data. The client never names a loader or
 * passes permissions: the widget id selects a definition, every permission the
 * definition requires is checked against the *caller* (never the dashboard
 * owner — sharing a dashboard shares its layout, not its data), and only then
 * does the loader run.
 *
 * Results are cached per (tenant, user, widget, config) for a short TTL, keyed
 * by user because row-level ticket authorization makes counts user-specific.
 */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;

const cache = new Map<string, { expiresAt: number; result: WidgetDataResult }>();

function cacheKey(tenant: string, userId: string, widgetId: string, config: Record<string, unknown>): string {
  const sortedConfig = JSON.stringify(config, Object.keys(config).sort());
  return `${tenant}:${userId}:${widgetId}:${sortedConfig}`;
}

function remember(key: string, result: WidgetDataResult): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map iteration is insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
}

export const getDashboardWidgetData = withAuth(async (
  user,
  { tenant },
  widgetId: string,
  config: Record<string, unknown> = {},
  options: { refresh?: boolean } = {},
): Promise<WidgetDataResult> => {
  const definition = getWidgetDefinition(widgetId);
  const loader = definition?.hasData ? WIDGET_LOADERS[widgetId] : undefined;
  if (!definition || !loader) return { status: 'error', message: 'Unknown widget.' };
  if (user.user_type !== 'internal') return { status: 'no-access' };

  const safeConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  // Permissions first, cache second: a revoked permission takes effect at once.
  const { knex } = await createTenantKnex();
  for (const [resource, action] of definition.requires) {
    if (!(await hasPermission(user, resource, action, knex))) {
      return { status: 'no-access' };
    }
  }

  const key = cacheKey(tenant, user.user_id, widgetId, safeConfig);
  const cached = cache.get(key);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const data = await loader({ tenant, userId: user.user_id, knex }, { ...definition.defaultConfig, ...safeConfig });
    const result: WidgetDataResult = { status: 'ok', data, loadedAt: new Date().toISOString() };
    remember(key, result);
    return result;
  } catch (error) {
    logger.error('[dashboards] widget data load failed', {
      tenant,
      widgetId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'error', message: 'This widget could not be loaded.' };
  }
});

/**
 * Which widgets the caller may add — the Add Widget drawer only offers these.
 * Static widgets with no requirements are always allowed.
 */
export const getAddableWidgetIds = withAuth(async (
  user,
  _ctx,
  widgetIds: string[],
): Promise<string[]> => {
  if (user.user_type !== 'internal' || !Array.isArray(widgetIds)) return [];
  const { knex } = await createTenantKnex();
  const allowed: string[] = [];
  const memo = new Map<string, boolean>();
  for (const widgetId of widgetIds) {
    const definition = getWidgetDefinition(widgetId);
    if (!definition) continue;
    let ok = true;
    for (const [resource, action] of definition.requires) {
      const permKey = `${resource}:${action}`;
      if (!memo.has(permKey)) memo.set(permKey, await hasPermission(user, resource, action, knex));
      if (!memo.get(permKey)) {
        ok = false;
        break;
      }
    }
    if (ok) allowed.push(widgetId);
  }
  return allowed;
});
