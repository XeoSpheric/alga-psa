import type {
  DashboardCapabilities,
  DashboardPrincipalType,
  DashboardRole,
  DashboardShareInput,
  DashboardShareRole,
} from './types';

/**
 * Role resolution for widget dashboards. Pure so the rules are unit-testable
 * without a database:
 *
 *  - The owner column wins outright.
 *  - Otherwise the highest role across the caller's direct user share and the
 *    share of every team they belong to. Edit beats view.
 *  - No owner match and no share → no access (the dashboard does not exist for
 *    the caller).
 */

const ROLE_RANK: Record<DashboardShareRole, number> = { view: 1, edit: 2 };

export interface ShareRowLike {
  principal_type: DashboardPrincipalType;
  principal_id: string;
  role: DashboardShareRole;
}

export function resolveDashboardRole(params: {
  ownerUserId: string;
  userId: string;
  shares: readonly ShareRowLike[];
  userTeamIds: readonly string[];
}): DashboardRole | null {
  const { ownerUserId, userId, shares, userTeamIds } = params;
  if (ownerUserId === userId) return 'owner';

  const teams = new Set(userTeamIds);
  let best: DashboardShareRole | null = null;
  for (const share of shares) {
    const applies = share.principal_type === 'user'
      ? share.principal_id === userId
      : teams.has(share.principal_id);
    if (applies && (best === null || ROLE_RANK[share.role] > ROLE_RANK[best])) {
      best = share.role;
    }
  }
  return best;
}

export function dashboardCapabilities(params: {
  role: DashboardRole;
  userId: string;
  shares: readonly ShareRowLike[];
  /** `dashboard:share` — needed to add or upgrade shares. */
  canSharePermission: boolean;
  /** `dashboard:manage` — act as owner on any dashboard the caller can see. */
  canManagePermission: boolean;
}): DashboardCapabilities {
  const { role, userId, shares, canSharePermission, canManagePermission } = params;
  const actsAsOwner = role === 'owner' || canManagePermission;
  const hasDirectShare = shares.some(
    (share) => share.principal_type === 'user' && share.principal_id === userId,
  );
  return {
    canEdit: actsAsOwner || role === 'edit',
    canManageShares: actsAsOwner,
    canAddShares: actsAsOwner && (canSharePermission || canManagePermission),
    canTransfer: actsAsOwner,
    canDelete: actsAsOwner,
    canLeave: role !== 'owner' && hasDirectShare,
  };
}

function shareKey(share: { principal_type: DashboardPrincipalType; principal_id: string }): string {
  return `${share.principal_type}:${share.principal_id}`;
}

/**
 * True when `next` grants access that `current` did not: a new principal, or a
 * view → edit upgrade. Removing or downgrading shares is never an escalation,
 * so an owner without `dashboard:share` can still pull a dashboard back.
 */
export function sharesEscalate(
  current: readonly ShareRowLike[],
  next: readonly DashboardShareInput[],
): boolean {
  const existing = new Map(current.map((share) => [shareKey(share), share.role]));
  return next.some((share) => {
    const before = existing.get(shareKey(share));
    return before === undefined || ROLE_RANK[share.role] > ROLE_RANK[before];
  });
}

/** Collapse duplicate principals (highest role wins) and drop the owner. */
export function normalizeShares(
  shares: readonly DashboardShareInput[],
  ownerUserId: string,
): DashboardShareInput[] {
  const byKey = new Map<string, DashboardShareInput>();
  for (const share of shares) {
    if (share.principal_type === 'user' && share.principal_id === ownerUserId) continue;
    const key = shareKey(share);
    const prior = byKey.get(key);
    if (!prior || ROLE_RANK[share.role] > ROLE_RANK[prior.role]) {
      byKey.set(key, { principal_type: share.principal_type, principal_id: share.principal_id, role: share.role });
    }
  }
  return [...byKey.values()];
}
