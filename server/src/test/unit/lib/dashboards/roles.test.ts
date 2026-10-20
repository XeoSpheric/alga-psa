import { describe, expect, it } from 'vitest';
import {
  dashboardCapabilities,
  normalizeShares,
  resolveDashboardRole,
  sharesEscalate,
  type ShareRowLike,
} from '@/lib/dashboards/roles';

const OWNER = 'owner-user';
const ME = 'me-user';
const OTHER = 'other-user';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';

describe('resolveDashboardRole', () => {
  it('owner column wins outright, even with a lower share row', () => {
    expect(resolveDashboardRole({
      ownerUserId: ME,
      userId: ME,
      shares: [{ principal_type: 'user', principal_id: ME, role: 'view' }],
      userTeamIds: [],
    })).toBe('owner');
  });

  it('no owner match and no share means no access', () => {
    expect(resolveDashboardRole({
      ownerUserId: OWNER,
      userId: ME,
      shares: [{ principal_type: 'user', principal_id: OTHER, role: 'edit' }],
      userTeamIds: [TEAM_B],
    })).toBeNull();
  });

  it('grants access through a team share', () => {
    expect(resolveDashboardRole({
      ownerUserId: OWNER,
      userId: ME,
      shares: [{ principal_type: 'team', principal_id: TEAM_A, role: 'view' }],
      userTeamIds: [TEAM_A],
    })).toBe('view');
  });

  it('edit beats view across direct and team shares', () => {
    const shares: ShareRowLike[] = [
      { principal_type: 'user', principal_id: ME, role: 'view' },
      { principal_type: 'team', principal_id: TEAM_A, role: 'edit' },
    ];
    expect(resolveDashboardRole({ ownerUserId: OWNER, userId: ME, shares, userTeamIds: [TEAM_A] })).toBe('edit');
  });

  it('a team share does not apply to a user outside the team, and a user id never matches a team row', () => {
    expect(resolveDashboardRole({
      ownerUserId: OWNER,
      userId: ME,
      shares: [{ principal_type: 'team', principal_id: ME, role: 'edit' }],
      userTeamIds: [],
    })).toBeNull();
  });
});

describe('dashboardCapabilities', () => {
  const base = { userId: ME, shares: [] as ShareRowLike[], canSharePermission: false, canManagePermission: false };

  it('owner without dashboard:share can edit, delete and transfer but not add shares', () => {
    const caps = dashboardCapabilities({ ...base, role: 'owner' });
    expect(caps).toMatchObject({
      canEdit: true,
      canManageShares: true,
      canAddShares: false,
      canTransfer: true,
      canDelete: true,
      canLeave: false,
    });
  });

  it('owner with dashboard:share can add shares', () => {
    expect(dashboardCapabilities({ ...base, role: 'owner', canSharePermission: true }).canAddShares).toBe(true);
  });

  it('edit role edits only', () => {
    const caps = dashboardCapabilities({
      ...base,
      role: 'edit',
      shares: [{ principal_type: 'user', principal_id: ME, role: 'edit' }],
    });
    expect(caps).toMatchObject({
      canEdit: true,
      canManageShares: false,
      canAddShares: false,
      canTransfer: false,
      canDelete: false,
      canLeave: true,
    });
  });

  it('view role cannot edit; can leave only with a direct share', () => {
    const viaTeam = dashboardCapabilities({
      ...base,
      role: 'view',
      shares: [{ principal_type: 'team', principal_id: TEAM_A, role: 'view' }],
    });
    expect(viaTeam.canEdit).toBe(false);
    expect(viaTeam.canLeave).toBe(false);

    const direct = dashboardCapabilities({
      ...base,
      role: 'view',
      shares: [{ principal_type: 'user', principal_id: ME, role: 'view' }],
    });
    expect(direct.canLeave).toBe(true);
  });

  it('dashboard:manage acts as owner on a dashboard the caller can see', () => {
    const caps = dashboardCapabilities({ ...base, role: 'view', canManagePermission: true });
    expect(caps).toMatchObject({ canEdit: true, canManageShares: true, canAddShares: true, canDelete: true, canTransfer: true });
  });
});

describe('sharesEscalate', () => {
  const current: ShareRowLike[] = [
    { principal_type: 'user', principal_id: ME, role: 'view' },
    { principal_type: 'team', principal_id: TEAM_A, role: 'edit' },
  ];

  it('removing or downgrading is not an escalation', () => {
    expect(sharesEscalate(current, [])).toBe(false);
    expect(sharesEscalate(current, [{ principal_type: 'team', principal_id: TEAM_A, role: 'view' }])).toBe(false);
  });

  it('a new principal or view → edit upgrade is an escalation', () => {
    expect(sharesEscalate(current, [{ principal_type: 'user', principal_id: OTHER, role: 'view' }])).toBe(true);
    expect(sharesEscalate(current, [{ principal_type: 'user', principal_id: ME, role: 'edit' }])).toBe(true);
  });
});

describe('normalizeShares', () => {
  it('drops the owner and collapses duplicates to the highest role', () => {
    expect(normalizeShares([
      { principal_type: 'user', principal_id: OWNER, role: 'edit' },
      { principal_type: 'user', principal_id: ME, role: 'view' },
      { principal_type: 'user', principal_id: ME, role: 'edit' },
      { principal_type: 'team', principal_id: TEAM_A, role: 'view' },
    ], OWNER)).toEqual([
      { principal_type: 'user', principal_id: ME, role: 'edit' },
      { principal_type: 'team', principal_id: TEAM_A, role: 'view' },
    ]);
  });
});
