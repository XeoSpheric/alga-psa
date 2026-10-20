import { z } from 'zod';
import {
  DASHBOARD_MAX_WIDGETS,
  DASHBOARD_NAME_MAX_LENGTH,
  WIDGET_SIZES,
  type DashboardLayout,
  type DashboardWidgetInstance,
  type WidgetSize,
} from './types';
import { getWidgetDefinition } from './widgets/definitions';

/**
 * Layout documents: strict on write, forgiving on read.
 *
 * Writes reject anything malformed — an unknown widget id, a size the widget
 * does not support, an oversized config — so a bad client cannot store junk.
 * Reads drop what no longer fits (a retired widget, a size a widget stopped
 * offering) instead of failing the whole dashboard.
 */

const MAX_CONFIG_BYTES = 2_000;

const instanceSchema = z.object({
  instanceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  widgetId: z.string().min(1).max(100),
  size: z.enum(WIDGET_SIZES as [WidgetSize, ...WidgetSize[]]),
  config: z.record(z.string(), z.unknown()).default({}),
});

const layoutSchema = z.object({
  version: z.literal(1),
  widgets: z.array(instanceSchema).max(DASHBOARD_MAX_WIDGETS),
});

export const EMPTY_LAYOUT: DashboardLayout = { version: 1, widgets: [] };

export type LayoutValidation =
  | { ok: true; layout: DashboardLayout }
  | { ok: false; detail: string };

export function validateLayoutForWrite(input: unknown): LayoutValidation {
  const parsed = layoutSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, detail };
  }

  const seen = new Set<string>();
  for (const widget of parsed.data.widgets) {
    if (seen.has(widget.instanceId)) {
      return { ok: false, detail: `duplicate instanceId ${widget.instanceId}` };
    }
    seen.add(widget.instanceId);

    const definition = getWidgetDefinition(widget.widgetId);
    if (!definition) return { ok: false, detail: `unknown widget ${widget.widgetId}` };
    if (!definition.sizes.includes(widget.size)) {
      return { ok: false, detail: `widget ${widget.widgetId} does not support size ${widget.size}` };
    }
    if (JSON.stringify(widget.config).length > MAX_CONFIG_BYTES) {
      return { ok: false, detail: `widget ${widget.instanceId} config is too large` };
    }
  }

  return { ok: true, layout: parsed.data as DashboardLayout };
}

/** Best-effort read of a stored layout; never throws. */
export function readStoredLayout(stored: unknown): DashboardLayout {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return EMPTY_LAYOUT;
    }
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { widgets?: unknown }).widgets)) {
    return EMPTY_LAYOUT;
  }

  const widgets: DashboardWidgetInstance[] = [];
  const seen = new Set<string>();
  for (const raw of (value as { widgets: unknown[] }).widgets) {
    const parsed = instanceSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.instanceId)) continue;
    const definition = getWidgetDefinition(parsed.data.widgetId);
    if (!definition) continue;
    seen.add(parsed.data.instanceId);
    widgets.push({
      ...parsed.data,
      size: definition.sizes.includes(parsed.data.size) ? parsed.data.size : definition.defaultSize,
    } as DashboardWidgetInstance);
    if (widgets.length >= DASHBOARD_MAX_WIDGETS) break;
  }
  return { version: 1, widgets };
}

export function normalizeDashboardName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > DASHBOARD_NAME_MAX_LENGTH) return null;
  return trimmed;
}
