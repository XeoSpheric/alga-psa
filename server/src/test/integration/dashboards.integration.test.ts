import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { createTestDbConnection, wireLocalTestDbEnv } from '../../../test-utils/dbConfig';

const dbRef = vi.hoisted(() => ({
  knex: null as Knex | null,
  tenant: '',
}));

const userRef = vi.hoisted(() => ({
  user: null as any,
}));

/** user_id → granted `resource:action` keys. */
const grantsRef = vi.hoisted(() => ({
  grants: new Map<string, Set<string>>(),
}));

const hasPermissionMock = vi.hoisted(() =>
  vi.fn(async (user: { user_id: string }, resource: string, action: string) =>
    grantsRef.grants.get(user.user_id)?.has(`${resource}:${action}`) ?? false,
  ),
);

vi.mock('@alga-psa/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alga-psa/db')>()),
  createTenantKnex: vi.fn(async () => ({ knex: dbRef.knex, tenant: dbRef.tenant })),
}));

vi.mock('@alga-psa/auth', () => ({
  withAuth: (action: any) => (...args: any[]) =>
    action(userRef.user, { tenant: dbRef.tenant }, ...args),
  hasPermission: hasPermissionMock,
}));

import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  getDashboard,
  leaveDashboard,
  listDashboards,
  resolveDashboardForPage,
  setDashboardShares,
  setLandingDashboard,
  transferDashboardOwnership,
  updateDashboard,
} from '@/lib/dashboards/dashboardActions';
import { getDashboardWidgetData } from '@/lib/dashboards/widgets/widgetDataActions';
import { getTicketListCounts, getTicketsForList } from '@alga-psa/tickets/actions/optimizedTicketActions';
import type { ITicketListFilters } from '@alga-psa/types';
import type { OpenTicketsByPriorityData } from '@/lib/dashboards/widgets/dataTypes';
import { tenantDb } from '@alga-psa/db';
import {
  getErrorMessage,
  isActionMessageError,
  isActionPermissionError,
} from '@alga-psa/ui/lib/errorHandling';
import type { DashboardLayout } from '@/lib/dashboards/types';

const HOOK_TIMEOUT = 240_000;

type TestUser = { user_id: string; user_type: 'internal' };

let db: Knex;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let teamId: string;

function actAs(user: TestUser, grants: string[] = []) {
  userRef.user = { ...user, tenant: dbRef.tenant };
  grantsRef.grants.set(user.user_id, new Set(['ticket:read', ...grants]));
}

function expectOk<T>(result: T): Exclude<T, { actionError: string } | { permissionError: string }> {
  if (isActionMessageError(result) || isActionPermissionError(result)) {
    throw new Error(`Expected success, got: ${getErrorMessage(result)}`);
  }
  return result as Exclude<T, { actionError: string } | { permissionError: string }>;
}

const layout: DashboardLayout = {
  version: 1,
  widgets: [{ instanceId: 'w1', widgetId: 'tickets.open-by-priority', size: 'sm', config: {} }],
};

async function cloneUser(tenant: string, sourceId: string, label: string): Promise<TestUser> {
  const source = await tenantDb(db, tenant).table('users').where({ user_id: sourceId }).first();
  const clonedId = uuidv4();
  await tenantDb(db, tenant).table('users').insert({
    ...source,
    user_id: clonedId,
    username: `dash-${label}-${clonedId}`,
    email: `dash-${label}-${clonedId}@example.com`,
  });
  return { user_id: clonedId, user_type: 'internal' };
}

describe('widget dashboards', () => {
  beforeAll(async () => {
    wireLocalTestDbEnv();
    db = await createTestDbConnection();
    dbRef.knex = db;

    const internalUsers = await tenantDb(db, '__test_discovery__')
      .unscoped('users', 'test discovery of seeded internal users for dashboards integration')
      .where({ user_type: 'internal' })
      .orderBy('created_at', 'asc')
      .select('tenant', 'user_id');
    expect(internalUsers.length).toBeGreaterThan(0);
    const tenant = internalUsers[0].tenant;
    dbRef.tenant = tenant;

    owner = { user_id: internalUsers[0].user_id, user_type: 'internal' };
    member = await cloneUser(tenant, owner.user_id, 'member');
    outsider = await cloneUser(tenant, owner.user_id, 'outsider');

    teamId = uuidv4();
    await tenantDb(db, tenant).table('teams').insert({
      tenant,
      team_id: teamId,
      team_name: `Dashboard team ${teamId.slice(0, 8)}`,
      manager_id: owner.user_id,
    });
    await tenantDb(db, tenant).table('team_members').insert({ tenant, team_id: teamId, user_id: member.user_id });
  }, HOOK_TIMEOUT);

  afterEach(async () => {
    const ids = [owner.user_id, member.user_id, outsider.user_id];
    const dashboards = await tenantDb(db, dbRef.tenant).table('dashboards').whereIn('owner_user_id', ids).select('dashboard_id');
    const dashboardIds = dashboards.map((row: { dashboard_id: string }) => row.dashboard_id);
    if (dashboardIds.length > 0) {
      await tenantDb(db, dbRef.tenant).table('dashboard_shares').whereIn('dashboard_id', dashboardIds).del();
      await tenantDb(db, dbRef.tenant).table('dashboards').whereIn('dashboard_id', dashboardIds).del();
    }
    await tenantDb(db, dbRef.tenant)
      .table('user_preferences')
      .whereIn('user_id', ids)
      .where('setting_name', 'msp_dashboard_landing_id')
      .del();
  });

  afterAll(async () => {
    await db?.destroy();
  }, HOOK_TIMEOUT);

  it('D001: an unshared dashboard is invisible to others and indistinguishable from a missing one', async () => {
    actAs(owner);
    const created = expectOk(await createDashboard({ name: 'My board', layout }));
    expect(created.role).toBe('owner');
    expect(created.layout.widgets).toHaveLength(1);

    actAs(outsider);
    const collection = expectOk(await listDashboards());
    expect([...collection.owned, ...collection.sharedWithMe].map((d) => d.dashboard_id)).not.toContain(created.dashboard_id);

    const hidden = await getDashboard(created.dashboard_id);
    const missing = await getDashboard(uuidv4());
    expect(isActionMessageError(hidden)).toBe(true);
    expect(hidden).toEqual(missing);
    expect(await updateDashboard(created.dashboard_id, { name: 'Hijacked' })).toEqual(missing);
    expect(await deleteDashboard(created.dashboard_id)).toEqual(missing);
    expect(await duplicateDashboard(created.dashboard_id)).toEqual(missing);
    expect(await setLandingDashboard(created.dashboard_id)).toEqual(missing);
  });

  it('D002: adding shares needs dashboard:share; removing does not', async () => {
    actAs(owner);
    const created = expectOk(await createDashboard({ name: 'Ops', layout }));
    const denied = await setDashboardShares(created.dashboard_id, [
      { principal_type: 'user', principal_id: member.user_id, role: 'view' },
    ]);
    expect(isActionPermissionError(denied)).toBe(true);

    actAs(owner, ['dashboard:share']);
    const shared = expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'user', principal_id: member.user_id, role: 'view' },
    ]));
    expect(shared.is_shared).toBe(true);
    expect(shared.shares).toHaveLength(1);

    // Owner who lost the permission can still pull the dashboard back.
    actAs(owner);
    const unshared = expectOk(await setDashboardShares(created.dashboard_id, []));
    expect(unshared.is_shared).toBe(false);
  });

  it('D003: team share grants access, edit beats view, and view cannot edit', async () => {
    actAs(owner, ['dashboard:share']);
    const created = expectOk(await createDashboard({ name: 'Team board', layout }));
    expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'team', principal_id: teamId, role: 'view' },
    ]));

    actAs(member);
    const asViewer = expectOk(await getDashboard(created.dashboard_id));
    expect(asViewer.role).toBe('view');
    expect(asViewer.capabilities.canEdit).toBe(false);
    expect(asViewer.capabilities.canLeave).toBe(false);
    expect(isActionPermissionError(await updateDashboard(created.dashboard_id, { name: 'Renamed' }))).toBe(true);
    expect(isActionPermissionError(await setDashboardShares(created.dashboard_id, []))).toBe(true);
    expect(isActionPermissionError(await deleteDashboard(created.dashboard_id))).toBe(true);
    // Access through a team cannot be "left" individually.
    expect(isActionMessageError(await leaveDashboard(created.dashboard_id))).toBe(true);
    const listed = expectOk(await listDashboards());
    expect(listed.sharedWithMe.map((d) => d.dashboard_id)).toContain(created.dashboard_id);

    actAs(owner, ['dashboard:share']);
    expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'team', principal_id: teamId, role: 'view' },
      { principal_type: 'user', principal_id: member.user_id, role: 'edit' },
    ]));

    actAs(member);
    const asEditor = expectOk(await getDashboard(created.dashboard_id));
    expect(asEditor.role).toBe('edit');
    const renamed = expectOk(await updateDashboard(created.dashboard_id, {
      name: 'Team board v2',
      expectedUpdatedAt: asEditor.updated_at,
    }));
    expect(renamed.name).toBe('Team board v2');
    // Editors still cannot manage shares or delete.
    expect(isActionPermissionError(await setDashboardShares(created.dashboard_id, []))).toBe(true);
    expect(isActionPermissionError(await deleteDashboard(created.dashboard_id))).toBe(true);

    // Leaving drops the direct share; the team share still applies.
    expectOk(await leaveDashboard(created.dashboard_id));
    expect(expectOk(await getDashboard(created.dashboard_id)).role).toBe('view');

    // Removing the user from the team revokes access entirely.
    await tenantDb(db, dbRef.tenant).table('team_members').where({ team_id: teamId, user_id: member.user_id }).del();
    expect(isActionMessageError(await getDashboard(created.dashboard_id))).toBe(true);
    await tenantDb(db, dbRef.tenant).table('team_members').insert({ tenant: dbRef.tenant, team_id: teamId, user_id: member.user_id });
  });

  it('D004: a stale save is rejected instead of clobbering a co-editor', async () => {
    actAs(owner);
    const created = expectOk(await createDashboard({ name: 'Concurrent', layout }));

    const first = expectOk(await updateDashboard(created.dashboard_id, {
      layout: { version: 1, widgets: [] },
      expectedUpdatedAt: created.updated_at,
    }));
    expect(first.layout.widgets).toHaveLength(0);

    const stale = await updateDashboard(created.dashboard_id, { layout, expectedUpdatedAt: created.updated_at });
    expect(isActionMessageError(stale)).toBe(true);

    const fresh = expectOk(await updateDashboard(created.dashboard_id, { layout, expectedUpdatedAt: first.updated_at }));
    expect(fresh.layout.widgets).toHaveLength(1);
  });

  it('D005: transfer keeps exactly one owner and leaves the old owner as an editor', async () => {
    actAs(owner, ['dashboard:share']);
    const created = expectOk(await createDashboard({ name: 'Handover', layout }));
    expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'user', principal_id: member.user_id, role: 'view' },
    ]));

    // The recipient already owns a dashboard of the same name.
    actAs(member);
    expectOk(await createDashboard({ name: 'Handover', layout }));
    expect(isActionPermissionError(await transferDashboardOwnership(created.dashboard_id, member.user_id))).toBe(true);

    actAs(owner);
    const transferred = expectOk(await transferDashboardOwnership(created.dashboard_id, member.user_id));
    expect(transferred.owner_user_id).toBe(member.user_id);
    expect(transferred.role).toBe('edit');
    expect(transferred.name).toBe('Handover (2)');

    const shares = await tenantDb(db, dbRef.tenant).table('dashboard_shares').where({ dashboard_id: created.dashboard_id });
    expect(shares).toEqual([
      expect.objectContaining({ principal_type: 'user', principal_id: owner.user_id, role: 'edit' }),
    ]);

    actAs(member);
    expect(expectOk(await getDashboard(created.dashboard_id)).role).toBe('owner');
  });

  it('D006: duplicate makes a private copy; landing resolves and falls back to Home', async () => {
    actAs(owner, ['dashboard:share']);
    const created = expectOk(await createDashboard({ name: 'Shared ops', layout }));
    expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'user', principal_id: member.user_id, role: 'view' },
    ]));

    actAs(member);
    const copy = expectOk(await duplicateDashboard(created.dashboard_id));
    expect(copy.role).toBe('owner');
    expect(copy.is_shared).toBe(false);
    expect(copy.name).toBe('Shared ops (copy)');
    expect(copy.layout).toEqual(created.layout);

    expectOk(await setLandingDashboard(created.dashboard_id));
    const landed = expectOk(await resolveDashboardForPage(null));
    expect(landed.active?.dashboard_id).toBe(created.dashboard_id);
    expect(expectOk(await resolveDashboardForPage('home')).active).toBeNull();

    // Once access is gone, the landing silently falls back to Home.
    actAs(owner);
    expectOk(await setDashboardShares(created.dashboard_id, []));
    actAs(member);
    const fallback = expectOk(await resolveDashboardForPage(null));
    expect(fallback.active).toBeNull();
    expect(fallback.notFound).toBe(false);
    expect(fallback.collection.landingDashboardId).toBeNull();
    expect(expectOk(await resolveDashboardForPage(created.dashboard_id)).notFound).toBe(true);
  });

  it('D007: editors cannot place widgets whose data they cannot read; viewers get no-access data', async () => {
    actAs(owner, ['dashboard:share']);
    const created = expectOk(await createDashboard({ name: 'Perms', layout: { version: 1, widgets: [] } }));
    expectOk(await setDashboardShares(created.dashboard_id, [
      { principal_type: 'user', principal_id: outsider.user_id, role: 'edit' },
    ]));

    // outsider has no ticket:read
    userRef.user = { ...outsider };
    grantsRef.grants.set(outsider.user_id, new Set());
    const denied = await updateDashboard(created.dashboard_id, { layout });
    expect(isActionPermissionError(denied)).toBe(true);
    expect(await getDashboardWidgetData('tickets.open-by-priority', {})).toEqual({ status: 'no-access' });
    expect(isActionPermissionError(await createDashboard({ name: 'Mine', layout }))).toBe(true);
  });

  it('D008: widget counts equal the ticket list it links to', async () => {
    actAs(owner);
    const filters = {
      statusId: 'open',
      priorityId: 'all',
      showOpenOnly: true,
      boardFilterState: 'active',
      bundleView: 'bundled',
    } as ITicketListFilters;

    const buckets = expectOk(await getTicketListCounts(filters, 'priority'));
    const list = expectOk(await getTicketsForList(filters, 1, 1));
    const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(bucketTotal).toBe(list.totalCount);

    for (const bucket of buckets.filter((b) => b.key)) {
      const perPriority = expectOk(await getTicketsForList({ ...filters, priorityId: bucket.key! }, 1, 1));
      expect(perPriority.totalCount, `priority ${bucket.key}`).toBe(bucket.count);
    }

    const widget = await getDashboardWidgetData('tickets.open-by-priority', {}, { refresh: true });
    expect(widget.status).toBe('ok');
    const data = (widget as { data: OpenTicketsByPriorityData }).data;
    expect(data.total).toBe(list.totalCount);
    for (const slice of data.slices.filter((s) => s.href)) {
      expect(slice.href).toBe(`/msp/tickets?board=all&statusId=open&priorityId=${slice.key}`);
    }
  });
});
