import type { NormalizedRmmAlertEvent, RmmActiveAlertFetcher } from '@alga-psa/shared/rmm/alerts';
import { registerRmmAlertFetcher } from '@alga-psa/shared/rmm/alerts';
import { createTenantKnex } from '@alga-psa/db';
import { tenantScopedTable } from '../common/db';
import { buildDattoClientForTenant } from './buildClient';
import { mapDattoAlertToEvent } from './alertMapper';
import { DATTO_RMM_PROVIDER } from './shared';

/**
 * Lists currently-open Datto RMM alerts for reconciliation
 * (GET /v2/account/alerts/open, paged). Only alerts for sites that are mapped
 * to an Alga client are returned: an unmapped site is one the tenant has not
 * chosen to manage, and its alerts would otherwise open client-less tickets.
 */
export const dattoRmmAlertFetcher: RmmActiveAlertFetcher = {
  async fetchActiveAlerts({ tenantId, integrationId }) {
    const client = await buildDattoClientForTenant(tenantId);
    if (!client) return [];

    const { knex } = await createTenantKnex();
    const mappings = await tenantScopedTable(knex, 'rmm_organization_mappings', tenantId)
      .where({ integration_id: integrationId })
      .whereNotNull('client_id')
      .select(['external_organization_id']);
    const mappedSiteUids = new Set<string>(
      (mappings as Array<{ external_organization_id?: unknown }>)
        .map((row) => String(row.external_organization_id ?? ''))
        .filter(Boolean)
    );
    if (mappedSiteUids.size === 0) return [];

    const alerts = await client.listOpenAlerts();

    return alerts
      .filter((alert) => alert?.resolved !== true)
      .filter((alert) => mappedSiteUids.has(String(alert?.alertSourceInfo?.siteUid ?? '')))
      .map((alert) => mapDattoAlertToEvent(alert, tenantId, integrationId))
      .filter((event): event is NormalizedRmmAlertEvent => event !== null);
  },
};

// Registration is a module side effect so any importer (the reconciliation
// dispatcher, the manual backfill) gets the fetcher wired.
registerRmmAlertFetcher(DATTO_RMM_PROVIDER, dattoRmmAlertFetcher);
