'use server';

import type { Knex } from 'knex';
import { createTenantKnex, tenantDb, withTransaction } from '@alga-psa/db';
import { withAuth, hasPermission } from '@alga-psa/auth';
import logger from '@alga-psa/core/logger';
import {
  actionError,
  permissionError,
  type ActionMessageError,
  type ActionPermissionError,
} from '@alga-psa/ui/lib/errorHandling';
import type { IUser } from '@alga-psa/types';
import {
  DashboardModel,
  type DashboardRowWithOwner,
  type DashboardShareRow,
} from './dashboardModel';
import { EMPTY_LAYOUT, normalizeDashboardName, readStoredLayout, validateLayoutForWrite } from './layout';
import { dashboardCapabilities, normalizeShares, resolveDashboardRole, sharesEscalate } from './roles';
import type {
  DashboardCollection,
  DashboardDetail,
  DashboardLayout,
  DashboardRole,
  DashboardShareInput,
  DashboardSummary,
} from './types';
import { HOME_DASHBOARD_ID } from './types';
import { getWidgetDefinition } from './widgets/definitions';

/**
 * Server actions for user-built widget dashboards.
 *
 * Rules (PLAN.md §2.3):
 *  - MSP users only. A dashboard the caller cannot see (not owner, no direct or
 *    team share) is indistinguishable from one that does not exist.
 *  - Owner (exactly one) and `edit` may change name and layout; `view` may not.
 *  - Only the owner manages shares, transfers or deletes; `dashboard:manage`
 *    grants the same on any dashboard the caller can see.
 *  - Adding a principal or upgrading view → edit needs `dashboard:share`
 *    (admins by default). Removing/downgrading never does.
 *  - Sharing shares the layout only; widget data always loads with the
 *    viewer's own permissions (see widgetDataActions).
 */

type DashboardActionError = ActionMessageError | ActionPermissionError;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANDING_SETTING = 'msp_dashboard_landing_id';
const ERR = 'msp/dashboard:dashboards.errors';

const notFound = (): DashboardActionError =>
  actionError('This dashboard is private or no longer exists.', `${ERR}.notFound`);
const invalidName = (): DashboardActionError =>
  actionError('A dashboard name must be between 1 and 100 characters.', `${ERR}.invalidName`);
const duplicateName = (name: string): DashboardActionError =>
  actionError(`You already have a dashboard named "${name}".`, `${ERR}.duplicateName`, { name });
const invalidLayout = (detail: string): DashboardActionError =>
  actionError(`The dashboard could not be saved: ${detail}`, `${ERR}.invalidLayout`, { detail });
const conflict = (): DashboardActionError =>
  actionError('Someone else changed this dashboard. Reload to see the latest version.', `${ERR}.conflict`);
const invalidShares = (): DashboardActionError =>
  actionError('One or more people or teams could not be found.', `${ERR}.invalidShares`);
const invalidOwner = (): DashboardActionError =>
  actionError('The new owner must be an active internal user.', `${ERR}.invalidOwner`);
const cannotLeave = (): DashboardActionError =>
  actionError('You have access through a team; ask the owner to change the team share.', `${ERR}.cannotLeave`);
const notMspUser = (): DashboardActionError =>
  permissionError('Permission denied: dashboards are available to MSP users only.', `${ERR}.mspOnly`);
const cannotEdit = (): DashboardActionError =>
  permissionError('Permission denied: you cannot change this dashboard.', `${ERR}.cannotEdit`);
const cannotManage = (): DashboardActionError =>
  permissionError('Permission denied: only the owner can do this.', `${ERR}.ownerOnly`);
const cannotAddWidget = (): DashboardActionError =>
  permissionError('Permission denied: you cannot add a widget whose data you cannot view.', `${ERR}.cannotAddWidget`);
const cannotShare = (): DashboardActionError =>
  permissionError('Permission denied: you cannot share dashboards.', `${ERR}.cannotShare`);

interface CallerContext {
  user: IUser;
  tenant: string;
  teamIds: string[];
  canSharePermission: boolean;
  canManagePermission: boolean;
}

async function loadCaller(user: IUser, tenant: string, trx: Knex.Transaction): Promise<CallerContext> {
  const [teamIds, canSharePermission, canManagePermission] = await Promise.all([
    DashboardModel.teamIdsForUser(trx, tenant, user.user_id),
    hasPermission(user, 'dashboard', 'share', trx),
    hasPermission(user, 'dashboard', 'manage', trx),
  ]);
  return { user, tenant, teamIds, canSharePermission, canManagePermission };
}

async function canUseWidgets(user: IUser, widgetIds: readonly string[], trx: Knex.Transaction): Promise<boolean> {
  const checked = new Map<string, boolean>();
  for (const widgetId of new Set(widgetIds)) {
    for (const [resource, action] of getWidgetDefinition(widgetId)?.requires ?? []) {
      const key = `${resource}:${action}`;
      if (!checked.has(key)) checked.set(key, await hasPermission(user, resource, action, trx));
      if (!checked.get(key)) return false;
    }
  }
  return true;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function ownerName(row: DashboardRowWithOwner): string {
  return [row.owner_first_name, row.owner_last_name].filter(Boolean).join(' ').trim();
}

function roleFor(row: DashboardRowWithOwner, shares: readonly DashboardShareRow[], caller: CallerContext): DashboardRole | null {
  return resolveDashboardRole({
    ownerUserId: row.owner_user_id,
    userId: caller.user.user_id,
    shares,
    userTeamIds: caller.teamIds,
  });
}

function toSummary(row: DashboardRowWithOwner, role: DashboardRole): DashboardSummary {
  return {
    dashboard_id: row.dashboard_id,
    name: row.name,
    owner_user_id: row.owner_user_id,
    owner_name: ownerName(row),
    role,
    is_shared: Number(row.share_count) > 0,
    updated_at: toIso(row.updated_at),
  };
}

function toDetail(row: DashboardRowWithOwner, shares: DashboardShareRow[], role: DashboardRole, caller: CallerContext): DashboardDetail {
  return {
    ...toSummary(row, role),
    layout: readStoredLayout(row.layout),
    shares: shares.map((share) => ({
      principal_type: share.principal_type,
      principal_id: share.principal_id,
      principal_name: share.principal_name ?? '',
      role: share.role,
    })),
    capabilities: dashboardCapabilities({
      role,
      userId: caller.user.user_id,
      shares,
      canSharePermission: caller.canSharePermission,
      canManagePermission: caller.canManagePermission,
    }),
  };
}

/** Load one visible dashboard with its shares and the caller's role, or null. */
async function loadVisible(
  trx: Knex.Transaction,
  caller: CallerContext,
  dashboardId: string,
): Promise<{ row: DashboardRowWithOwner; shares: DashboardShareRow[]; role: DashboardRole } | null> {
  if (typeof dashboardId !== 'string' || !UUID_PATTERN.test(dashboardId)) return null;
  const row = await DashboardModel.findVisible(trx, caller.tenant, dashboardId, caller.user.user_id, caller.teamIds);
  if (!row) return null;
  const shares = (await DashboardModel.sharesFor(trx, caller.tenant, [row.dashboard_id])).get(row.dashboard_id) ?? [];
  const role = roleFor(row, shares, caller);
  return role ? { row, shares, role } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

async function readLanding(trx: Knex.Transaction, tenant: string, userId: string): Promise<string | null> {
  const pref = await tenantDb(trx, tenant).table('user_preferences')
    .where({ user_id: userId, setting_name: LANDING_SETTING })
    .first('setting_value');
  let value: unknown = pref?.setting_value;
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

async function writeLanding(trx: Knex.Transaction, tenant: string, userId: string, dashboardId: string | null): Promise<void> {
  const db = tenantDb(trx, tenant).table('user_preferences');
  if (dashboardId === null) {
    await db.where({ user_id: userId, setting_name: LANDING_SETTING }).del();
    return;
  }
  // Compute timestamp before query - CitusDB requires IMMUTABLE values in ON CONFLICT UPDATE
  const now = new Date();
  await db
    .insert({
      tenant,
      user_id: userId,
      setting_name: LANDING_SETTING,
      setting_value: JSON.stringify(dashboardId),
      updated_at: now,
    })
    .onConflict(['tenant', 'user_id', 'setting_name'])
    .merge({ setting_value: JSON.stringify(dashboardId), updated_at: now });
}

interface VisibleSet {
  collection: DashboardCollection;
  rows: DashboardRowWithOwner[];
  sharesById: Map<string, DashboardShareRow[]>;
  roles: Map<string, DashboardRole>;
}

async function loadVisibleSet(trx: Knex.Transaction, caller: CallerContext): Promise<VisibleSet> {
  const rows = await DashboardModel.listVisible(trx, caller.tenant, caller.user.user_id, caller.teamIds);
  const sharesById = await DashboardModel.sharesFor(trx, caller.tenant, rows.map((row) => row.dashboard_id));

  const owned: DashboardSummary[] = [];
  const sharedWithMe: DashboardSummary[] = [];
  const roles = new Map<string, DashboardRole>();
  for (const row of rows) {
    const role = roleFor(row, sharesById.get(row.dashboard_id) ?? [], caller);
    if (!role) continue;
    roles.set(row.dashboard_id, role);
    (role === 'owner' ? owned : sharedWithMe).push(toSummary(row, role));
  }

  // A landing dashboard that has since become invisible simply stops being one.
  const storedLanding = await readLanding(trx, caller.tenant, caller.user.user_id);
  const landingDashboardId = storedLanding && roles.has(storedLanding) ? storedLanding : null;
  return { collection: { owned, sharedWithMe, landingDashboardId }, rows, sharesById, roles };
}

function guardMsp(user: IUser): DashboardActionError | null {
  return user.user_type === 'internal' ? null : notMspUser();
}

export const listDashboards = withAuth(async (
  user,
  { tenant },
): Promise<DashboardCollection | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    return (await loadVisibleSet(trx, caller)).collection;
  });
});

export const getDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const found = await loadVisible(trx, caller, dashboardId);
    if (!found) return notFound();
    return toDetail(found.row, found.shares, found.role, caller);
  });
});

export const createDashboard = withAuth(async (
  user,
  { tenant },
  input: { name: string; layout?: DashboardLayout },
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const name = normalizeDashboardName(input?.name);
  if (!name) return invalidName();
  const validated = validateLayoutForWrite(input?.layout ?? EMPTY_LAYOUT);
  if (validated.ok === false) return invalidLayout(validated.detail);

  const { knex } = await createTenantKnex();
  try {
    return await withTransaction(knex, async (trx) => {
      const caller = await loadCaller(user, tenant, trx);
      if (!(await canUseWidgets(user, validated.layout.widgets.map((widget) => widget.widgetId), trx))) {
        return cannotAddWidget();
      }
      if (await DashboardModel.nameTaken(trx, tenant, { ownerUserId: user.user_id, name })) {
        return duplicateName(name);
      }
      const dashboardId = await DashboardModel.insert(trx, tenant, {
        name,
        owner_user_id: user.user_id,
        layout: validated.layout,
      });
      const found = await loadVisible(trx, caller, dashboardId);
      if (!found) throw new Error(`Dashboard ${dashboardId} was not readable immediately after insert`);
      return toDetail(found.row, found.shares, found.role, caller);
    });
  } catch (error) {
    if (isUniqueViolation(error)) return duplicateName(name);
    throw error;
  }
});

export const updateDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
  patch: { name?: string; layout?: DashboardLayout; expectedUpdatedAt?: string | null },
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  let name: string | undefined;
  if (patch?.name !== undefined) {
    const normalized = normalizeDashboardName(patch.name);
    if (!normalized) return invalidName();
    name = normalized;
  }
  let layout: DashboardLayout | undefined;
  if (patch?.layout !== undefined) {
    const validated = validateLayoutForWrite(patch.layout);
    if (validated.ok === false) return invalidLayout(validated.detail);
    layout = validated.layout;
  }

  const { knex } = await createTenantKnex();
  try {
    return await withTransaction(knex, async (trx) => {
      const caller = await loadCaller(user, tenant, trx);
      const found = await loadVisible(trx, caller, dashboardId);
      if (!found) return notFound();
      const caps = dashboardCapabilities({
        role: found.role,
        userId: user.user_id,
        shares: found.shares,
        canSharePermission: caller.canSharePermission,
        canManagePermission: caller.canManagePermission,
      });
      if (!caps.canEdit) return cannotEdit();

      // An editor can only place widgets whose data they can read themselves.
      if (layout) {
        const before = new Set(readStoredLayout(found.row.layout).widgets.map((widget) => widget.instanceId));
        const added = layout.widgets.filter((widget) => !before.has(widget.instanceId));
        if (!(await canUseWidgets(user, added.map((widget) => widget.widgetId), trx))) return cannotAddWidget();
      }

      if (name !== undefined && await DashboardModel.nameTaken(trx, tenant, {
        ownerUserId: found.row.owner_user_id,
        name,
        excludeDashboardId: found.row.dashboard_id,
      })) {
        return duplicateName(name);
      }

      const applied = await DashboardModel.update(
        trx,
        tenant,
        found.row.dashboard_id,
        patch.expectedUpdatedAt ?? null,
        { name, layout },
      );
      if (!applied) return conflict();

      const updated = await loadVisible(trx, caller, found.row.dashboard_id);
      if (!updated) return notFound();
      return toDetail(updated.row, updated.shares, updated.role, caller);
    });
  } catch (error) {
    if (isUniqueViolation(error) && name !== undefined) return duplicateName(name);
    throw error;
  }
});

export const deleteDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
): Promise<{ deleted: true } | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const found = await loadVisible(trx, caller, dashboardId);
    if (!found) return notFound();
    if (found.role !== 'owner' && !caller.canManagePermission) return cannotManage();

    await DashboardModel.delete(trx, tenant, found.row.dashboard_id);
    logger.info('[dashboards] deleted dashboard', { tenant, dashboardId: found.row.dashboard_id, by: user.user_id });
    return { deleted: true as const };
  });
});

export const duplicateDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
  requestedName?: string,
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  let name: string | null = null;
  if (requestedName !== undefined) {
    name = normalizeDashboardName(requestedName);
    if (!name) return invalidName();
  }

  const { knex } = await createTenantKnex();
  try {
    return await withTransaction(knex, async (trx) => {
      const caller = await loadCaller(user, tenant, trx);
      const found = await loadVisible(trx, caller, dashboardId);
      if (!found) return notFound();

      const finalName = name
        ? name
        : await DashboardModel.availableName(trx, tenant, user.user_id, `${found.row.name} (copy)`.slice(0, 100));
      if (name && await DashboardModel.nameTaken(trx, tenant, { ownerUserId: user.user_id, name })) {
        return duplicateName(name);
      }

      // The copy is private: shares never travel with a duplicate.
      const copyId = await DashboardModel.insert(trx, tenant, {
        name: finalName,
        owner_user_id: user.user_id,
        layout: readStoredLayout(found.row.layout),
      });
      const copy = await loadVisible(trx, caller, copyId);
      if (!copy) throw new Error(`Dashboard ${copyId} was not readable immediately after insert`);
      return toDetail(copy.row, copy.shares, copy.role, caller);
    });
  } catch (error) {
    if (isUniqueViolation(error) && name) return duplicateName(name);
    throw error;
  }
});

export const setDashboardShares = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
  shares: DashboardShareInput[],
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;
  if (!Array.isArray(shares) || shares.some((share) =>
    !share
    || (share.principal_type !== 'user' && share.principal_type !== 'team')
    || (share.role !== 'edit' && share.role !== 'view')
    || typeof share.principal_id !== 'string'
    || !UUID_PATTERN.test(share.principal_id))) {
    return invalidShares();
  }

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const found = await loadVisible(trx, caller, dashboardId);
    if (!found) return notFound();
    if (found.role !== 'owner' && !caller.canManagePermission) return cannotManage();

    const next = normalizeShares(shares, found.row.owner_user_id);
    if (sharesEscalate(found.shares, next) && !caller.canSharePermission && !caller.canManagePermission) {
      return cannotShare();
    }

    const userIds = next.filter((share) => share.principal_type === 'user').map((share) => share.principal_id);
    const teamIds = next.filter((share) => share.principal_type === 'team').map((share) => share.principal_id);
    const [knownUsers, knownTeams] = await Promise.all([
      DashboardModel.existingInternalUserIds(trx, tenant, userIds),
      DashboardModel.existingTeamIds(trx, tenant, teamIds),
    ]);
    if (userIds.some((id) => !knownUsers.has(id)) || teamIds.some((id) => !knownTeams.has(id))) {
      return invalidShares();
    }

    await DashboardModel.replaceShares(trx, tenant, found.row.dashboard_id, next);
    logger.info('[dashboards] shares updated', {
      tenant,
      dashboardId: found.row.dashboard_id,
      by: user.user_id,
      shareCount: next.length,
    });

    const updated = await loadVisible(trx, caller, found.row.dashboard_id);
    // An admin acting with `manage` on a dashboard they reach through a share
    // they just removed has left its reach.
    if (!updated) return notFound();
    return toDetail(updated.row, updated.shares, updated.role, caller);
  });
});

export const transferDashboardOwnership = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
  newOwnerUserId: string,
): Promise<DashboardDetail | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;
  if (typeof newOwnerUserId !== 'string' || !UUID_PATTERN.test(newOwnerUserId)) return invalidOwner();

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const found = await loadVisible(trx, caller, dashboardId);
    if (!found) return notFound();
    if (found.role !== 'owner' && !caller.canManagePermission) return cannotManage();
    if (newOwnerUserId === found.row.owner_user_id) return toDetail(found.row, found.shares, found.role, caller);
    if (!(await DashboardModel.isActiveInternalUser(trx, tenant, newOwnerUserId))) return invalidOwner();

    // The new owner may already own a dashboard of this name.
    const name = await DashboardModel.availableName(trx, tenant, newOwnerUserId, found.row.name);
    await DashboardModel.transferOwnership(
      trx,
      tenant,
      found.row.dashboard_id,
      found.row.owner_user_id,
      newOwnerUserId,
      name,
    );
    logger.info('[dashboards] ownership transferred', {
      tenant,
      dashboardId: found.row.dashboard_id,
      from: found.row.owner_user_id,
      to: newOwnerUserId,
      by: user.user_id,
    });

    const updated = await loadVisible(trx, caller, found.row.dashboard_id);
    if (!updated) return notFound();
    return toDetail(updated.row, updated.shares, updated.role, caller);
  });
});

export const leaveDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string,
): Promise<{ left: true } | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const found = await loadVisible(trx, caller, dashboardId);
    if (!found) return notFound();
    if (found.role === 'owner') return cannotManage();

    const removed = await DashboardModel.removeUserShare(trx, tenant, found.row.dashboard_id, user.user_id);
    if (removed === 0) return cannotLeave();

    const landing = await readLanding(trx, tenant, user.user_id);
    if (landing === found.row.dashboard_id) await writeLanding(trx, tenant, user.user_id, null);
    return { left: true as const };
  });
});

/** Pin a dashboard as the caller's landing page; null returns to Home. */
export const setLandingDashboard = withAuth(async (
  user,
  { tenant },
  dashboardId: string | null,
): Promise<{ landingDashboardId: string | null } | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    if (dashboardId !== null) {
      const caller = await loadCaller(user, tenant, trx);
      const found = await loadVisible(trx, caller, dashboardId);
      if (!found) return notFound();
    }
    await writeLanding(trx, tenant, user.user_id, dashboardId);
    return { landingDashboardId: dashboardId };
  });
});

/**
 * Page-load resolver: which dashboard `/msp/dashboard?d=…` should show.
 * Returns null for Home (explicit `home`, no landing, or an invisible id).
 */
export const resolveDashboardForPage = withAuth(async (
  user,
  { tenant },
  requested: string | null,
): Promise<{ collection: DashboardCollection; active: DashboardDetail | null; notFound: boolean } | DashboardActionError> => {
  const denied = guardMsp(user);
  if (denied) return denied;

  const { knex } = await createTenantKnex();
  return withTransaction(knex, async (trx) => {
    const caller = await loadCaller(user, tenant, trx);
    const { collection, rows, sharesById, roles } = await loadVisibleSet(trx, caller);
    const { landingDashboardId } = collection;

    const wantedId = requested === null ? landingDashboardId : requested;
    if (!wantedId || wantedId === HOME_DASHBOARD_ID) return { collection, active: null, notFound: false };

    const row = rows.find((candidate) => candidate.dashboard_id === wantedId);
    const role = row ? roles.get(row.dashboard_id) : undefined;
    if (!row || !role) return { collection, active: null, notFound: true };
    return {
      collection,
      active: toDetail(row, sharesById.get(row.dashboard_id) ?? [], role, caller),
      notFound: false,
    };
  });
});
