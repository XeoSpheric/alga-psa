import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actionSource = readFileSync(
  new URL('../src/actions/accountingSyncActions.ts', import.meta.url),
  'utf8',
);
const hookSource = readFileSync(
  new URL('../src/components/invoices/useInvoiceSyncStatuses.ts', import.meta.url),
  'utf8',
);

describe('CE invoice sync-status capability probe', () => {
  it('returns an empty status map instead of throwing on core CE invoice screens', () => {
    const statusAction = actionSource.slice(
      actionSource.indexOf('export const getInvoiceSyncStatuses'),
      actionSource.indexOf('export interface AccountingSyncRealmInfo'),
    );

    // Xero ships in CE, so the probe is no longer edition-gated. A user
    // without catalog access gets an empty map rather than a Forbidden throw.
    expect(statusAction).toContain("if (!(await hasPermission(user, 'accounting_integrations', 'catalog_read')))");
    expect(statusAction).toContain('return {};');
    expect(statusAction.indexOf('return {};')).toBeLessThan(statusAction.indexOf('createTenantKnex'));
    expect(statusAction).not.toContain('checkCatalogReadAccess');
  });

  it('hides accounting-sync UI when the capability probe returns no statuses', () => {
    expect(hookSource).toContain('invoiceIds.length > 0 && Object.keys(result).length === 0');
    expect(hookSource).toContain('setHidden(true)');
  });

  it('returns no statuses when no accounting provider is connected', () => {
    const statusAction = actionSource.slice(
      actionSource.indexOf('export const getInvoiceSyncStatuses'),
      actionSource.indexOf('export interface AccountingSyncRealmInfo'),
    );

    expect(statusAction).toContain('const target = await resolveSyncTarget(knex, tenant).catch(() => null);');
    expect(statusAction).toContain('if (!target)');
    expect(statusAction.indexOf('if (!target)')).toBeLessThan(statusAction.indexOf("table('tenant_external_entity_mappings')"));
  });
});
