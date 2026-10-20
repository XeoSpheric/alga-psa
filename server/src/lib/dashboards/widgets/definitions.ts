import type { WidgetSize } from '../types';

/**
 * Widget catalog metadata — client-safe. The server-only data loaders live in
 * `loaders.ts`, keyed by the same ids, so loader code never ships to the
 * browser. A widget id is a stable public identifier stored in saved layouts:
 * retire a widget by removing it here (saved layouts drop it on read), never by
 * reusing its id.
 */

export type WidgetCategory = 'general' | 'tickets' | 'assets' | 'time' | 'sla' | 'surveys' | 'projects' | 'sales';

export type WidgetPermission = readonly [resource: string, action: string];

export interface WidgetDefinition {
  id: string;
  category: WidgetCategory;
  titleKey: string;
  titleDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  /** Every pair must pass `hasPermission` to add the widget or load its data. */
  requires: readonly WidgetPermission[];
  defaultConfig: Record<string, unknown>;
  /** False for static widgets (e.g. quick links) that render without a loader. */
  hasData: boolean;
}

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  {
    id: 'tickets.open-by-priority',
    category: 'tickets',
    titleKey: 'widgets.catalog.ticketsOpenByPriority.title',
    titleDefault: 'Open Tickets by Priority',
    descriptionKey: 'widgets.catalog.ticketsOpenByPriority.description',
    descriptionDefault: 'Donut of open tickets per priority. Click a slice to open the matching tickets.',
    sizes: ['sm', 'md', 'wide', 'lg'],
    defaultSize: 'sm',
    requires: [['ticket', 'read']],
    defaultConfig: {},
    hasData: true,
  },
  {
    id: 'general.quick-links',
    category: 'general',
    titleKey: 'widgets.catalog.quickLinks.title',
    titleDefault: 'Quick Links',
    descriptionKey: 'widgets.catalog.quickLinks.description',
    descriptionDefault: 'Shortcuts to tickets, projects, schedule, and other areas.',
    sizes: ['sm', 'md', 'wide', 'lg'],
    defaultSize: 'wide',
    requires: [],
    defaultConfig: {},
    hasData: false,
  },
];

const BY_ID = new Map(WIDGET_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getWidgetDefinition(widgetId: string): WidgetDefinition | undefined {
  return BY_ID.get(widgetId);
}

export const WIDGET_CATEGORY_ORDER: readonly WidgetCategory[] = [
  'general', 'tickets', 'assets', 'time', 'sla', 'surveys', 'projects', 'sales',
];
