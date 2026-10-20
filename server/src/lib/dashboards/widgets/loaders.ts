import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';
import { isActionMessageError, isActionPermissionError, getErrorMessage } from '@alga-psa/ui/lib/errorHandling';
import { getTicketListCounts } from '@alga-psa/tickets/actions/optimizedTicketActions';
import type { ITicketListFilters } from '@alga-psa/types';
import { ticketListHref } from './links';
import type { DonutSlice, OpenTicketsByPriorityData } from './dataTypes';

/**
 * Server-only widget data loaders, keyed by widget id. Each runs after the
 * dispatcher (widgetDataActions) has confirmed the caller holds every
 * permission the widget's definition requires, and must itself apply the same
 * row-level visibility as the list it links to — the ticket loaders do this by
 * going through `getTicketListCounts`, which reuses the ticket list query.
 */

export interface WidgetLoadContext {
  tenant: string;
  userId: string;
  knex: Knex;
}

export type WidgetLoader = (ctx: WidgetLoadContext, config: Record<string, unknown>) => Promise<unknown>;

/** The ticket list's own defaults (server/src/app/msp/tickets/page.tsx), on every board. */
const OPEN_TICKETS_FILTERS: ITicketListFilters = {
  statusId: 'open',
  priorityId: 'all',
  showOpenOnly: true,
  boardFilterState: 'active',
  bundleView: 'bundled',
} as ITicketListFilters;

function unwrap<T>(result: T): Exclude<T, { actionError: string } | { permissionError: string }> {
  if (isActionMessageError(result) || isActionPermissionError(result)) {
    throw new Error(getErrorMessage(result));
  }
  return result as Exclude<T, { actionError: string } | { permissionError: string }>;
}

async function loadOpenTicketsByPriority(ctx: WidgetLoadContext): Promise<OpenTicketsByPriorityData> {
  const buckets = unwrap(await getTicketListCounts(OPEN_TICKETS_FILTERS, 'priority'));
  const priorityIds = buckets.map((bucket) => bucket.key).filter((key): key is string => Boolean(key));

  const priorities: Array<{ priority_id: string; priority_name: string; color: string | null; order_number: number | null }> =
    priorityIds.length > 0
      ? await tenantDb(ctx.knex, ctx.tenant)
        .table('priorities')
        .whereIn('priority_id', priorityIds)
        .select('priority_id', 'priority_name', 'color', 'order_number')
      : [];
  const byId = new Map(priorities.map((priority) => [priority.priority_id, priority]));

  const slices: Array<DonutSlice & { order: number }> = buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => {
      const priority = bucket.key ? byId.get(bucket.key) : undefined;
      return {
        key: bucket.key ?? 'none',
        label: priority?.priority_name ?? '',
        count: bucket.count,
        color: priority?.color ?? null,
        // The list has no "no priority" filter, so that slice is not clickable.
        href: bucket.key ? ticketListHref({ statusId: 'open', priorityId: bucket.key }) : null,
        order: priority?.order_number ?? Number.MAX_SAFE_INTEGER,
      };
    });

  // Highest priority first: lower order_number ranks higher in every
  // priority picker in the app.
  slices.sort((a, b) => a.order - b.order || b.count - a.count);

  return {
    total: slices.reduce((sum, slice) => sum + slice.count, 0),
    slices: slices.map(({ order: _order, ...slice }) => slice),
    listHref: ticketListHref({ statusId: 'open' }),
  };
}

export const WIDGET_LOADERS: Record<string, WidgetLoader> = {
  'tickets.open-by-priority': loadOpenTicketsByPriority,
};
