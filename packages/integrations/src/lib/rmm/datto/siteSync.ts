/**
 * Datto RMM site sync: mirrors /v2/account/sites into rmm_organization_mappings.
 *
 * Like the device engine this is a plain lib module (no 'use server') so the
 * settings action can wrap it with a permission check and a job could call it
 * without an acting user.
 *
 * A site becomes one mapping row keyed by its uid. The admin chooses the Alga
 * client; the sync only ever *suggests* one, in metadata, from the site's
 * Autotask company name and then its own name. Re-syncing refreshes the name
 * and metadata but never touches client_id, auto_sync_assets or the other
 * columns an admin owns. A mapping whose site no longer appears in Datto is
 * flagged (metadata.missing_in_datto) and never deleted; the flag clears when
 * the site comes back.
 */
import logger from '@alga-psa/core/logger';
import { createTenantKnex } from '@alga-psa/db';

import { tenantScopedTable } from '../common/db';
import { buildDattoClientForTenant, getDattoIntegrationRow } from './buildClient';
import { DattoSyncConfigError, dattoErrorMessage, publishRmmSyncEvent, type DattoSyncResult } from './deviceSync';
import { DATTO_RMM_PROVIDER } from './shared';
import type { DattoSite } from './types';

const PROVIDER = DATTO_RMM_PROVIDER;

interface ClientCandidate {
  clientId: string;
  clientName: string;
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Lower-cased client name -> client. A name shared by several clients is
 * ambiguous, so it is dropped rather than guessed at.
 */
export function buildClientNameIndex(
  clients: Array<{ client_id: unknown; client_name?: unknown }>
): Map<string, ClientCandidate> {
  const index = new Map<string, ClientCandidate>();
  const ambiguous = new Set<string>();
  for (const row of clients) {
    const key = normalizeName(row.client_name);
    if (!key || row.client_id == null) continue;
    if (index.has(key)) {
      ambiguous.add(key);
      continue;
    }
    index.set(key, { clientId: String(row.client_id), clientName: String(row.client_name).trim() });
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

/**
 * Case-insensitive exact match of the site's Autotask company name, then its
 * own name, against the client index. Suggestion only: callers must not assign.
 */
export function suggestClientForDattoSite(
  site: Pick<DattoSite, 'name' | 'autotaskCompanyName'>,
  index: Map<string, ClientCandidate>
): ClientCandidate | null {
  for (const candidate of [site.autotaskCompanyName, site.name]) {
    const key = normalizeName(candidate);
    if (!key) continue;
    const match = index.get(key);
    if (match) return match;
  }
  return null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function runDattoRmmSiteSync(args: {
  tenant: string;
  actorUserId?: string;
}): Promise<DattoSyncResult> {
  const { tenant, actorUserId } = args;
  const errors: string[] = [];
  // Used for emitting failure events in the catch block.
  let integrationId: string | undefined;

  try {
    const { knex } = await createTenantKnex();
    const integration = await getDattoIntegrationRow(knex, tenant);

    if (!integration?.integration_id) {
      return {
        success: false,
        error: 'Datto RMM is not configured yet. Save settings first.',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_failed: 0,
      };
    }

    const integrationIdForEvents = String(integration.integration_id);
    integrationId = integrationIdForEvents;

    await publishRmmSyncEvent({
      eventType: 'RMM_SYNC_STARTED',
      tenantId: tenant,
      actorUserId,
      integrationId: integrationIdForEvents,
      syncType: 'organizations',
    });

    const client = await buildDattoClientForTenant(tenant, { allowInactive: true });
    if (!client) {
      throw new DattoSyncConfigError('Datto RMM credentials are not configured. Save and test the connection first.');
    }

    const sites = await client.listSites();

    const existingRows: any[] = await tenantScopedTable(knex, 'rmm_organization_mappings', tenant)
      .where({ integration_id: integration.integration_id })
      .select(['external_organization_id', 'metadata']);
    const existing = new Map<string, Record<string, unknown>>(
      existingRows.map((row) => [String(row.external_organization_id), parseMetadata(row.metadata)])
    );

    const clientRows: any[] = await tenantScopedTable(knex, 'clients', tenant).select(['client_id', 'client_name']);
    const clientIndex = buildClientNameIndex(clientRows);

    let created = 0;
    let updated = 0;
    const seenSiteUids = new Set<string>();

    for (const site of sites) {
      const siteUid = String(site?.uid ?? '').trim();
      if (!siteUid) {
        errors.push('Site record missing uid');
        continue;
      }

      seenSiteUids.add(siteUid);
      const name = String(site.name ?? '').trim() || siteUid;
      const suggestion = suggestClientForDattoSite(site, clientIndex);
      const metadata = {
        datto_site_id: site.id ?? null,
        autotask_company_id: site.autotaskCompanyId ?? null,
        autotask_company_name: site.autotaskCompanyName ?? null,
        on_demand: site.onDemand === true,
        portal_url: site.portalUrl ?? null,
        missing_in_datto: false,
        suggested_client_id: suggestion?.clientId ?? null,
        suggested_client_name: suggestion?.clientName ?? null,
      };

      const prior = existing.get(siteUid);
      if (prior) updated += 1;
      else created += 1;

      try {
        await tenantScopedTable(knex, 'rmm_organization_mappings', tenant)
          .insert({
            tenant,
            integration_id: integration.integration_id,
            external_organization_id: siteUid,
            external_organization_name: name,
            // On-demand sites are not managed estates; start with sync off.
            // Other new sites keep the column default.
            ...(site.onDemand === true ? { auto_sync_assets: false } : {}),
            metadata,
          })
          .onConflict(['tenant', 'integration_id', 'external_organization_id'])
          // Only what the provider owns. client_id, auto_sync_assets, contact
          // and billing settings belong to the admin and are never merged.
          .merge({
            external_organization_name: name,
            metadata: { ...(prior ?? {}), ...metadata },
            updated_at: new Date().toISOString(),
          });
      } catch (err) {
        if (prior) updated -= 1;
        else created -= 1;
        errors.push(`${siteUid}: ${dattoErrorMessage(err)}`);
      }
    }

    // A site that vanished from Datto keeps its mapping (assets and billing
    // hang off it); it is only flagged so the UI and device sync can tell.
    let missing = 0;
    for (const [siteUid, prior] of existing) {
      if (seenSiteUids.has(siteUid)) continue;
      missing += 1;
      if (prior.missing_in_datto === true) continue;
      try {
        await tenantScopedTable(knex, 'rmm_organization_mappings', tenant)
          .where({ integration_id: integration.integration_id, external_organization_id: siteUid })
          .update({ metadata: { ...prior, missing_in_datto: true }, updated_at: new Date().toISOString() });
      } catch (err) {
        errors.push(`${siteUid}: ${dattoErrorMessage(err)}`);
      }
    }
    if (missing) {
      logger.warn('[DattoRmmSiteSync] mapped sites no longer listed by Datto', { tenant, provider: PROVIDER, missing });
    }

    await tenantScopedTable(knex, 'rmm_integrations', tenant)
      .where({ provider: PROVIDER })
      .update({ last_sync_at: knex.fn.now(), sync_error: errors.length ? errors.slice(0, 5).join('; ') : null });

    await publishRmmSyncEvent({
      eventType: 'RMM_SYNC_COMPLETED',
      tenantId: tenant,
      actorUserId,
      integrationId: integrationIdForEvents,
      syncType: 'organizations',
      itemsProcessed: sites.length,
      itemsCreated: created,
      itemsUpdated: updated,
      itemsFailed: errors.length,
    });

    return {
      success: true,
      items_processed: sites.length,
      items_created: created,
      items_updated: updated,
      items_failed: errors.length,
      errors: errors.length ? errors : undefined,
    };
  } catch (err) {
    const message = dattoErrorMessage(err);
    logger.warn('[DattoRmmSiteSync] run failed', { tenant, provider: PROVIDER, error: message });
    if (integrationId) {
      await publishRmmSyncEvent({
        eventType: 'RMM_SYNC_FAILED',
        tenantId: tenant,
        actorUserId,
        integrationId,
        syncType: 'organizations',
        errorMessage: message,
      });
    }
    return {
      success: false,
      error: message,
      items_processed: 0,
      items_created: 0,
      items_updated: 0,
      items_failed: errors.length,
      errors: errors.length ? errors : undefined,
    };
  }
}
