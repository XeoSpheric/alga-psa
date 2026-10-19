import { runWithTenant } from '@alga-psa/db';
import { runDattoRmmDeviceSync } from './deviceSync';

/**
 * Datto RMM's incremental device sync for the rmm-device-sync job.
 *
 * Datto has no server-side delta — /v2/site/{uid}/devices takes only paging
 * parameters — so "incremental" is the same page walk with the result filtered
 * on lastSeen / lastAuditDate. Fewer ingest writes and audit calls, but the
 * same number of listing reads.
 *
 * Like Tactical RMM this sync ships in packages/integrations rather than under
 * ee/, so it is available in CE as well as EE.
 */
export const dattoRmmDeviceSyncStrategy = {
  async syncDevicesIncremental(input: {
    tenantId: string;
    integrationId: string;
    since: Date;
  }): Promise<{ devicesProcessed: number }> {
    // The engine resolves its own connection via createTenantKnex(), which reads
    // the AsyncLocalStorage tenant — a job has none, so establish it here.
    return runWithTenant(input.tenantId, async () => {
      const result = await runDattoRmmDeviceSync(
        { tenant: input.tenantId },
        { syncType: 'incremental', since: input.since },
      );

      // The engine reports failure in a field rather than by throwing, and the
      // job advances the delta cursor on any resolved promise. Returning
      // normally here would skip whatever changed in the failed window,
      // permanently and silently.
      if (!result.success) {
        const detail = result.errors?.length ? `: ${result.errors.join('; ')}` : '';
        throw new Error(
          result.error
            ? `Datto RMM incremental device sync failed: ${result.error}`
            : `Datto RMM incremental device sync reported failure (${result.items_failed} failed)${detail}`,
        );
      }

      return { devicesProcessed: result.items_processed ?? 0 };
    });
  },
};
