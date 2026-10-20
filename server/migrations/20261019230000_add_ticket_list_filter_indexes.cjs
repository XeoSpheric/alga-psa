// Serves the ticket list, dashboard and per-client views
// (packages/tickets/src/actions/optimizedTicketActions.ts). Those queries filter
// tickets by assignee, client or board and sort by entered_at (the default list
// sort), but tickets only had indexes on its keys, status and SLA columns, so
// every list load scanned the tenant's whole ticket set. The existing unique
// (tenant, ticket_id, assigned_to) index can't serve assignee lookups because
// ticket_id comes before assigned_to.
//
// Non-unique, built CONCURRENTLY like the other index-only migrations on large
// distributed tables (see 20261009130100_add_ticket_audit_logs_actor_index.cjs).
// Hence transaction:false.
exports.config = { transaction: false };

const INDEXES = [
  ['tickets_tenant_assigned_to_idx', '(tenant, assigned_to)'],
  ['tickets_tenant_client_entered_at_idx', '(tenant, client_id, entered_at DESC)'],
  ['tickets_tenant_board_entered_at_idx', '(tenant, board_id, entered_at DESC)'],
  ['tickets_tenant_entered_at_idx', '(tenant, entered_at DESC)'],
];

exports.up = async function (knex) {
  for (const [name, columns] of INDEXES) {
    await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON tickets ${columns}`);
  }
};

exports.down = async function (knex) {
  for (const [name] of INDEXES) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  }
};
