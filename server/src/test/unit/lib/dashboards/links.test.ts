import { describe, expect, it } from 'vitest';
import { dashboardHref, ticketListHref } from '@/lib/dashboards/widgets/links';
import { hasBoardFilterParam, hasTicketViewFilterParams } from '@alga-psa/tickets/lib/boardTabs';

describe('ticketListHref', () => {
  it('names the All tickets board scope so a remembered board cannot narrow the list', () => {
    const href = ticketListHref({ statusId: 'open', priorityId: 'p-1' });
    expect(href).toBe('/msp/tickets?board=all&statusId=open&priorityId=p-1');
    const search = href.split('?')[1];
    // The tickets page skips the remembered board and the board's stored view.
    expect(hasBoardFilterParam(search)).toBe(true);
    expect(hasTicketViewFilterParams(search)).toBe(true);
  });

  it('uses explicit boards instead of the all-boards scope when given', () => {
    expect(ticketListHref({ boardIds: ['b1', 'b2'] })).toBe('/msp/tickets?boardIds=b1%2Cb2&statusId=open');
  });

  it('defaults to open tickets and carries the other filters', () => {
    expect(ticketListHref({ assignedToIds: ['u1'], includeUnassigned: true, dueDateFilter: 'overdue', slaStatusFilter: 'breached' }))
      .toBe('/msp/tickets?board=all&statusId=open&assignedToIds=u1&includeUnassigned=true&dueDateFilter=overdue&slaStatusFilter=breached');
  });
});

describe('dashboardHref', () => {
  it('links Home explicitly so a landing dashboard does not take over', () => {
    expect(dashboardHref(null)).toBe('/msp/dashboard?d=home');
    expect(dashboardHref('abc')).toBe('/msp/dashboard?d=abc');
  });
});
