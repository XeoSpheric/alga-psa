/**
 * Deep-link builders for widget drill-downs. Every clickable number or chart
 * segment gets its href from here, so URL formats live in one tested place.
 *
 * Ticket links always name a board scope: without one, the tickets page
 * restores the user's last-active board tab and a count computed across all
 * boards would land on a narrower list (see `ALL_BOARDS_URL_PARAM` in
 * packages/tickets/src/lib/boardTabs.ts).
 */

export interface TicketListLinkParams {
  /** `open` | `closed` | `all` | a status uuid. */
  statusId?: string;
  priorityId?: string;
  boardIds?: string[];
  assignedToIds?: string[];
  includeUnassigned?: boolean;
  dueDateFilter?: 'overdue' | 'today' | 'upcoming' | 'no_due_date';
  slaStatusFilter?: 'breached' | 'on_track' | 'paused' | 'has_sla' | 'no_sla';
}

export function ticketListHref(params: TicketListLinkParams): string {
  const search = new URLSearchParams();
  if (params.boardIds && params.boardIds.length > 0) {
    search.set('boardIds', params.boardIds.join(','));
  } else {
    search.set('board', 'all');
  }
  search.set('statusId', params.statusId ?? 'open');
  if (params.priorityId) search.set('priorityId', params.priorityId);
  if (params.assignedToIds && params.assignedToIds.length > 0) {
    search.set('assignedToIds', params.assignedToIds.join(','));
  }
  if (params.includeUnassigned) search.set('includeUnassigned', 'true');
  if (params.dueDateFilter) search.set('dueDateFilter', params.dueDateFilter);
  if (params.slaStatusFilter) search.set('slaStatusFilter', params.slaStatusFilter);
  return `/msp/tickets?${search.toString()}`;
}

export function dashboardHref(dashboardId: string | null): string {
  return dashboardId ? `/msp/dashboard?d=${encodeURIComponent(dashboardId)}` : '/msp/dashboard?d=home';
}
