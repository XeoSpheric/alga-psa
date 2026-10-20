/**
 * Shared (client-safe) types for user-built widget dashboards.
 * See docs/plans/2026-10-19-dashboard-widgets/PLAN.md.
 */

/** The caller's effective role on one dashboard. Exactly one user is `owner`. */
export type DashboardRole = 'owner' | 'edit' | 'view';

/** Roles a share row can grant. Ownership is a column, never a share. */
export type DashboardShareRole = 'edit' | 'view';

export type DashboardPrincipalType = 'user' | 'team';

/** Fixed tile sizes on the 4-column grid: sm 1x1, md 1x2, wide 2x1, lg 2x2. */
export type WidgetSize = 'sm' | 'md' | 'wide' | 'lg';

export const WIDGET_SIZES: readonly WidgetSize[] = ['sm', 'md', 'wide', 'lg'];

export interface DashboardWidgetInstance {
  /** Stable per placement, so one widget can appear twice with different config. */
  instanceId: string;
  widgetId: string;
  size: WidgetSize;
  config: Record<string, unknown>;
}

export interface DashboardLayout {
  version: 1;
  widgets: DashboardWidgetInstance[];
}

export interface DashboardShare {
  principal_type: DashboardPrincipalType;
  principal_id: string;
  /** Display name resolved at read time; empty when the principal is gone. */
  principal_name: string;
  role: DashboardShareRole;
}

export interface DashboardCapabilities {
  canEdit: boolean;
  /** Add, change or remove shares. Adding/upgrading also needs `dashboard:share`. */
  canManageShares: boolean;
  /** Owner without `dashboard:share` may still remove or downgrade shares. */
  canAddShares: boolean;
  canTransfer: boolean;
  canDelete: boolean;
  /** Has a direct user share (team access is left by leaving the team). */
  canLeave: boolean;
}

export interface DashboardSummary {
  dashboard_id: string;
  name: string;
  owner_user_id: string;
  owner_name: string;
  role: DashboardRole;
  /** True when at least one share row exists. */
  is_shared: boolean;
  updated_at: string;
}

export interface DashboardDetail extends DashboardSummary {
  layout: DashboardLayout;
  shares: DashboardShare[];
  capabilities: DashboardCapabilities;
}

export interface DashboardCollection {
  owned: DashboardSummary[];
  sharedWithMe: DashboardSummary[];
  /** The caller's chosen landing dashboard, or null for Home. */
  landingDashboardId: string | null;
}

export interface DashboardShareInput {
  principal_type: DashboardPrincipalType;
  principal_id: string;
  role: DashboardShareRole;
}

/** `?d=` value that selects the built-in Home dashboard explicitly. */
export const HOME_DASHBOARD_ID = 'home';

export const DASHBOARD_NAME_MAX_LENGTH = 100;
export const DASHBOARD_MAX_WIDGETS = 40;
