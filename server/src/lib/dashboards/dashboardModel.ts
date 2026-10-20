import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';
import type {
  DashboardLayout,
  DashboardPrincipalType,
  DashboardShareInput,
  DashboardShareRole,
} from './types';
import { DASHBOARD_NAME_MAX_LENGTH } from './types';

/**
 * Data access for `dashboards` / `dashboard_shares`.
 *
 * Every read that can reach a user goes through `visibleTo`: a dashboard is
 * visible when the caller owns it, or holds a share directly or through one of
 * their teams. There is deliberately no "load any dashboard by id" helper — a
 * dashboard you cannot see must be indistinguishable from one that does not
 * exist, and the reliable way to keep that true is to never fetch it.
 */

type Conn = Knex | Knex.Transaction;

export interface DashboardRow {
  tenant: string;
  dashboard_id: string;
  name: string;
  owner_user_id: string;
  layout: unknown;
  schema_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface DashboardRowWithOwner extends DashboardRow {
  owner_first_name: string | null;
  owner_last_name: string | null;
  share_count: number | string;
}

export interface DashboardShareRow {
  principal_type: DashboardPrincipalType;
  principal_id: string;
  role: DashboardShareRole;
  principal_name: string | null;
}

function dashboards(conn: Conn, tenant: string) {
  return tenantDb(conn, tenant).table<DashboardRow>('dashboards');
}

function shares(conn: Conn, tenant: string) {
  return tenantDb(conn, tenant).table('dashboard_shares');
}

function selectWithOwner(conn: Conn, tenant: string) {
  const shareCount = tenantDb(conn, tenant)
    .table('dashboard_shares as sc')
    .count('*')
    .whereRaw('sc.dashboard_id = d.dashboard_id')
    .as('share_count');
  return tenantDb(conn, tenant)
    .table('dashboards as d')
    .leftJoin('users as u', function joinOwner() {
      this.on('u.tenant', '=', 'd.tenant').andOn('u.user_id', '=', 'd.owner_user_id');
    })
    .select(
      'd.*',
      'u.first_name as owner_first_name',
      'u.last_name as owner_last_name',
      shareCount,
    );
}

function visibleTo(conn: Conn, tenant: string, query: Knex.QueryBuilder, userId: string, teamIds: readonly string[]) {
  const sharedWithCaller = tenantDb(conn, tenant)
    .table('dashboard_shares as ds')
    .select(conn.raw('1'))
    .whereRaw('ds.dashboard_id = d.dashboard_id')
    .where(function principal() {
      this.where({ 'ds.principal_type': 'user', 'ds.principal_id': userId });
      if (teamIds.length > 0) {
        this.orWhere(function team() {
          this.where('ds.principal_type', 'team').whereIn('ds.principal_id', teamIds as string[]);
        });
      }
    });
  return query.where(function ownedOrShared() {
    this.where('d.owner_user_id', userId).orWhereExists(sharedWithCaller);
  });
}

export const DashboardModel = {
  async teamIdsForUser(conn: Conn, tenant: string, userId: string): Promise<string[]> {
    const rows = await tenantDb(conn, tenant)
      .table('team_members')
      .where({ user_id: userId })
      .select('team_id');
    return rows.map((row: { team_id: string }) => row.team_id);
  },

  /** Every dashboard the caller owns or has been shared, by name. */
  async listVisible(conn: Conn, tenant: string, userId: string, teamIds: readonly string[]): Promise<DashboardRowWithOwner[]> {
    return visibleTo(conn, tenant, selectWithOwner(conn, tenant), userId, teamIds)
      .orderByRaw('lower(d.name) asc');
  },

  async findVisible(
    conn: Conn,
    tenant: string,
    dashboardId: string,
    userId: string,
    teamIds: readonly string[],
  ): Promise<DashboardRowWithOwner | undefined> {
    const query = selectWithOwner(conn, tenant).where('d.dashboard_id', dashboardId);
    return visibleTo(conn, tenant, query, userId, teamIds).first();
  },

  /** Share rows for the given dashboards, keyed by dashboard id. */
  async sharesFor(conn: Conn, tenant: string, dashboardIds: readonly string[]): Promise<Map<string, DashboardShareRow[]>> {
    const result = new Map<string, DashboardShareRow[]>();
    if (dashboardIds.length === 0) return result;
    const rows = await tenantDb(conn, tenant)
      .table('dashboard_shares as ds')
      .leftJoin('users as su', function joinUser() {
        this.on('su.tenant', '=', 'ds.tenant')
          .andOn('su.user_id', '=', 'ds.principal_id')
          .andOnVal('ds.principal_type', '=', 'user');
      })
      .leftJoin('teams as st', function joinTeam() {
        this.on('st.tenant', '=', 'ds.tenant')
          .andOn('st.team_id', '=', 'ds.principal_id')
          .andOnVal('ds.principal_type', '=', 'team');
      })
      .whereIn('ds.dashboard_id', dashboardIds as string[])
      .select(
        'ds.dashboard_id',
        'ds.principal_type',
        'ds.principal_id',
        'ds.role',
        'su.first_name',
        'su.last_name',
        'st.team_name',
      )
      .orderBy([{ column: 'ds.principal_type', order: 'desc' }, { column: 'ds.created_at', order: 'asc' }]);

    for (const row of rows as Array<Record<string, string | null>>) {
      const list = result.get(row.dashboard_id as string) ?? [];
      list.push({
        principal_type: row.principal_type as DashboardPrincipalType,
        principal_id: row.principal_id as string,
        role: row.role as DashboardShareRole,
        principal_name: row.principal_type === 'team'
          ? row.team_name ?? null
          : [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
      });
      result.set(row.dashboard_id as string, list);
    }
    return result;
  },

  async nameTaken(
    conn: Conn,
    tenant: string,
    params: { ownerUserId: string; name: string; excludeDashboardId?: string },
  ): Promise<boolean> {
    const query = dashboards(conn, tenant)
      .where({ owner_user_id: params.ownerUserId })
      .whereRaw('lower(name) = lower(?)', [params.name]);
    if (params.excludeDashboardId) query.whereNot('dashboard_id', params.excludeDashboardId);
    return Boolean(await query.first('dashboard_id'));
  },

  /** First free "Name", "Name (2)", "Name (3)"… for an owner. */
  async availableName(conn: Conn, tenant: string, ownerUserId: string, base: string): Promise<string> {
    let name = base;
    for (let attempt = 2; await DashboardModel.nameTaken(conn, tenant, { ownerUserId, name }); attempt += 1) {
      const suffix = ` (${attempt})`;
      name = `${base.slice(0, DASHBOARD_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    }
    return name;
  },

  async insert(
    conn: Conn,
    tenant: string,
    row: { name: string; owner_user_id: string; layout: DashboardLayout },
  ): Promise<string> {
    const [inserted] = await dashboards(conn, tenant)
      .insert({
        tenant,
        name: row.name,
        owner_user_id: row.owner_user_id,
        layout: JSON.stringify(row.layout),
        schema_version: 1,
      })
      .returning('dashboard_id');
    return typeof inserted === 'string' ? inserted : (inserted as { dashboard_id: string }).dashboard_id;
  },

  /**
   * Optimistic update: applies only when `updated_at` still matches what the
   * caller loaded. Returns false on a concurrent edit.
   */
  async update(
    conn: Conn,
    tenant: string,
    dashboardId: string,
    expectedUpdatedAt: string | null,
    patch: { name?: string; layout?: DashboardLayout },
  ): Promise<boolean> {
    const update: Record<string, unknown> = { updated_at: conn.fn.now() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.layout !== undefined) update.layout = JSON.stringify(patch.layout);
    const query = dashboards(conn, tenant).where({ dashboard_id: dashboardId });
    // Postgres keeps microseconds; the ISO string the client holds has
    // milliseconds. Compare at the client's precision.
    if (expectedUpdatedAt) {
      query.whereRaw("date_trunc('milliseconds', updated_at) = ?", [new Date(expectedUpdatedAt)]);
    }
    const count = await query.update(update);
    return Number(count) > 0;
  },

  async delete(conn: Conn, tenant: string, dashboardId: string): Promise<void> {
    await shares(conn, tenant).where({ dashboard_id: dashboardId }).del();
    await dashboards(conn, tenant).where({ dashboard_id: dashboardId }).del();
  },

  async replaceShares(conn: Conn, tenant: string, dashboardId: string, next: readonly DashboardShareInput[]): Promise<void> {
    await shares(conn, tenant).where({ dashboard_id: dashboardId }).del();
    if (next.length === 0) return;
    await shares(conn, tenant).insert(next.map((share) => ({
      tenant,
      dashboard_id: dashboardId,
      principal_type: share.principal_type,
      principal_id: share.principal_id,
      role: share.role,
    })));
  },

  async removeUserShare(conn: Conn, tenant: string, dashboardId: string, userId: string): Promise<number> {
    return shares(conn, tenant)
      .where({ dashboard_id: dashboardId, principal_type: 'user', principal_id: userId })
      .del();
  },

  /**
   * Hand a dashboard to a new owner. The previous owner keeps `edit` access,
   * and any direct share the new owner held is removed (ownership supersedes it).
   */
  async transferOwnership(
    conn: Conn,
    tenant: string,
    dashboardId: string,
    previousOwnerId: string,
    newOwnerId: string,
    name: string,
  ): Promise<void> {
    await shares(conn, tenant)
      .where({ dashboard_id: dashboardId, principal_type: 'user' })
      .whereIn('principal_id', [newOwnerId, previousOwnerId])
      .del();
    await dashboards(conn, tenant)
      .where({ dashboard_id: dashboardId })
      .update({ owner_user_id: newOwnerId, name, updated_at: conn.fn.now() });
    await shares(conn, tenant).insert({
      tenant,
      dashboard_id: dashboardId,
      principal_type: 'user',
      principal_id: previousOwnerId,
      role: 'edit',
    });
  },

  async isActiveInternalUser(conn: Conn, tenant: string, userId: string): Promise<boolean> {
    const row = await tenantDb(conn, tenant)
      .table('users')
      .where({ user_id: userId, user_type: 'internal' })
      .where(function active() {
        this.where('is_inactive', false).orWhereNull('is_inactive');
      })
      .first('user_id');
    return Boolean(row);
  },

  async existingTeamIds(conn: Conn, tenant: string, teamIds: readonly string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await tenantDb(conn, tenant).table('teams').whereIn('team_id', teamIds as string[]).select('team_id');
    return new Set(rows.map((row: { team_id: string }) => row.team_id));
  },

  async existingInternalUserIds(conn: Conn, tenant: string, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tenantDb(conn, tenant)
      .table('users')
      .whereIn('user_id', userIds as string[])
      .where({ user_type: 'internal' })
      .select('user_id');
    return new Set(rows.map((row: { user_id: string }) => row.user_id));
  },
};
