import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reconciliation re-feeds a still-open suppressed alert with the RMM's original
 * alert time. Judging the maintenance window at that time would keep it
 * suppressed forever, so a reprocess is judged at the current time instead.
 * Also covers the mapping's billing profile reaching the auto-created ticket.
 */
const h = vi.hoisted(() => ({
  existing: undefined as Record<string, unknown> | undefined,
  windowCalls: [] as Array<Record<string, unknown>>,
  createTicket: vi.fn(async () => ({ ticket_id: 'ticket-new' })),
}));

const RULE = { rule_id: 'rule-1', name: 'all', conditions: {}, actions: { createTicket: true } };

vi.mock('@alga-psa/db', () => ({
  withTransaction: async (_knex: unknown, fn: (trx: unknown) => Promise<unknown>) => fn({}),
  registerAfterCommit: () => undefined,
  tenantDb: () => ({
    tenantJoin: () => undefined,
    table: (name: string) => {
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        andWhereNot: () => qb,
        whereNotNull: () => qb,
        orderBy: () => qb,
        select: () => qb,
        update: async () => 1,
        insert: () => ({ returning: async () => [{ alert_id: 'alert-new' }] }),
        then: (resolve: (v: unknown) => unknown) => resolve(name === 'rmm_alert_rules' ? [RULE] : []),
        first: async () => {
          switch (name) {
            case 'rmm_alerts':
              return h.existing;
            case 'rmm_organization_mappings':
              return {
                client_id: 'client-1',
                external_organization_name: 'Site One',
                default_contact_id: 'contact-1',
                billing_profile_id: 'profile-1',
              };
            default:
              return undefined;
          }
        },
      };
      return qb;
    },
  }),
}));
vi.mock('@alga-psa/event-bus/publishers', () => ({ publishWorkflowEvent: vi.fn() }));
vi.mock('../ticketCreator', () => ({
  addAlertInternalNote: async () => undefined,
  createTicketForAlert: (...a: unknown[]) => (h.createTicket as any)(...a),
  providerLabel: (p: string) => p,
}));
vi.mock('../ticketCreatedEvent', () => ({ publishRmmTicketCreated: async () => undefined }));
vi.mock('../windowMatcher', () => ({
  findMatchingWindow: (_windows: unknown, ctx: Record<string, unknown>) => {
    h.windowCalls.push(ctx);
    return null;
  },
}));

import { processRmmAlertEvent } from '../processRmmAlertEvent';

const OCCURRED_AT = '2026-01-01T00:00:00.000Z';
const event = {
  kind: 'triggered',
  tenantId: 'tenant-1',
  integrationId: 'int-1',
  provider: 'datto',
  externalAlertId: 'alert-ext-1',
  externalDeviceId: null,
  externalOrganizationId: 'site-1',
  severity: 'critical',
  occurredAt: OCCURRED_AT,
} as any;

describe('processTriggered maintenance-window time and mapping context', () => {
  beforeEach(() => {
    h.existing = undefined;
    h.windowCalls = [];
    h.createTicket.mockClear();
  });

  it('judges a reprocessed suppressed alert at the current time, not its original occurredAt', async () => {
    h.existing = { alert_id: 'alert-1', status: 'suppressed', ticket_id: null, device_name: null };
    const before = Date.now();
    await processRmmAlertEvent({ knex: {} as any }, event, { reprocessSuppressed: true });

    const at = new Date(h.windowCalls[0].occurredAt as string).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps occurredAt on first ingest, even when reconciliation passes reprocessSuppressed', async () => {
    await processRmmAlertEvent({ knex: {} as any }, event, { reprocessSuppressed: true });
    expect(h.windowCalls[0].occurredAt).toBe(OCCURRED_AT);
  });

  it('keeps occurredAt for a previously resolved alert that re-triggers', async () => {
    h.existing = { alert_id: 'alert-1', status: 'resolved', ticket_id: null, device_name: null };
    await processRmmAlertEvent({ knex: {} as any }, event, { reprocessSuppressed: true });
    expect(h.windowCalls[0].occurredAt).toBe(OCCURRED_AT);
  });

  it("passes the organization mapping's billing profile to the auto-created ticket", async () => {
    const result = await processRmmAlertEvent({ knex: {} as any }, event);
    expect(result.outcome).toBe('ticket_created');
    expect(h.createTicket).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clientId: 'client-1',
        mappingDefaultContactId: 'contact-1',
        mappingBillingProfileId: 'profile-1',
      })
    );
  });
});
