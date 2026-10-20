/** Client-safe shapes returned by widget data loaders. */

export interface DonutSlice {
  /** Stable key (e.g. priority id); `none` for the empty bucket. */
  key: string;
  /** Display label from tenant data; empty → the widget supplies a localized fallback. */
  label: string;
  count: number;
  /** Hex color from tenant data, or null to use the palette. */
  color: string | null;
  /** Drill-down target, or null when the list cannot filter to this slice. */
  href: string | null;
}

export interface OpenTicketsByPriorityData {
  total: number;
  slices: DonutSlice[];
  /** All open tickets — the center number links here. */
  listHref: string;
}

export type WidgetDataResult<T = unknown> =
  | { status: 'ok'; data: T; loadedAt: string }
  | { status: 'no-access' }
  | { status: 'error'; message: string };
