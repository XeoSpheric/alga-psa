/**
 * User-built widget dashboards (2026-10-19)
 *
 * A dashboard is a named grid of pre-built widgets owned by exactly one user
 * and optionally shared with users and/or teams at an `edit` or `view` role.
 *
 * See docs/plans/2026-10-19-dashboard-widgets/PLAN.md §2.3.
 *
 *  - `owner_user_id` is a column, not a share row, so "exactly one owner" is
 *    enforced by the schema. Transferring ownership rewrites the column.
 *  - A dashboard with no `dashboard_shares` rows is private to its owner.
 *  - `layout` is the validated `{ version, widgets: [...] }` document; widget
 *    ids are checked against the in-code registry, not by a constraint, so
 *    adding a widget is a code change rather than a migration.
 *  - `principal_type` / `role` are text with check constraints rather than
 *    enums, matching `list_views.visibility`.
 *
 * Composite (tenant, id) primary keys, Citus distribution by tenant, and no
 * ON DELETE SET NULL (unsupported on Citus): the user-deletion action removes a
 * departing owner's private dashboards and hands their shared ones over, and
 * removes their share rows.
 */

const { ensureTenantDistribution } = require('./utils/citusDistribution.cjs');

async function addForeignKeyIfMissing(knex, constraintName, sql) {
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${constraintName}'
      ) THEN
        ${sql};
      END IF;
    END $$;
  `);
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('dashboards'))) {
    await knex.schema.createTable('dashboards', (table) => {
      table.uuid('tenant').notNullable();
      table.uuid('dashboard_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.text('name').notNullable();
      table.uuid('owner_user_id').notNullable();
      table.jsonb('layout').notNullable()
        .comment('Dashboard layout document: { version, widgets: [{ instanceId, widgetId, size, config }] }.');
      table.integer('schema_version').notNullable().defaultTo(1);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.primary(['tenant', 'dashboard_id']);
    });

    await knex.raw(`
      ALTER TABLE dashboards
      ADD CONSTRAINT dashboards_name_length_check
      CHECK (char_length(name) BETWEEN 1 AND 100)
    `);

    await knex.raw(`
      CREATE INDEX dashboards_owner_idx
      ON dashboards (tenant, owner_user_id)
    `);

    // A user cannot own two dashboards of the same name. Includes the Citus
    // distribution column (tenant).
    await knex.raw(`
      CREATE UNIQUE INDEX dashboards_owner_name_unique
      ON dashboards (tenant, owner_user_id, lower(name))
    `);
  }

  if (!(await knex.schema.hasTable('dashboard_shares'))) {
    await knex.schema.createTable('dashboard_shares', (table) => {
      table.uuid('tenant').notNullable();
      table.uuid('share_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('dashboard_id').notNullable();
      table.text('principal_type').notNullable().comment("'user' | 'team'");
      table.uuid('principal_id').notNullable().comment('users.user_id or teams.team_id');
      table.text('role').notNullable().comment("'edit' | 'view'");
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.primary(['tenant', 'share_id']);
    });

    await knex.raw(`
      ALTER TABLE dashboard_shares
      ADD CONSTRAINT dashboard_shares_principal_type_check
      CHECK (principal_type IN ('user', 'team'))
    `);
    await knex.raw(`
      ALTER TABLE dashboard_shares
      ADD CONSTRAINT dashboard_shares_role_check
      CHECK (role IN ('edit', 'view'))
    `);

    await knex.raw(`
      CREATE UNIQUE INDEX dashboard_shares_principal_unique
      ON dashboard_shares (tenant, dashboard_id, principal_type, principal_id)
    `);
    // "Shared with me" lookup: by user id directly, and by each of the user's teams.
    await knex.raw(`
      CREATE INDEX dashboard_shares_principal_idx
      ON dashboard_shares (tenant, principal_type, principal_id)
    `);
  }

  // Distribute before FKs — Citus requires both sides distributed first.
  await ensureTenantDistribution(knex, 'dashboards');
  await ensureTenantDistribution(knex, 'dashboard_shares');

  await addForeignKeyIfMissing(knex, 'dashboards_tenant_fkey', `
    ALTER TABLE dashboards
      ADD CONSTRAINT dashboards_tenant_fkey
      FOREIGN KEY (tenant)
      REFERENCES tenants(tenant)
      ON DELETE CASCADE
  `);

  await addForeignKeyIfMissing(knex, 'dashboards_owner_fkey', `
    ALTER TABLE dashboards
      ADD CONSTRAINT dashboards_owner_fkey
      FOREIGN KEY (tenant, owner_user_id)
      REFERENCES users(tenant, user_id)
  `);

  await addForeignKeyIfMissing(knex, 'dashboard_shares_tenant_fkey', `
    ALTER TABLE dashboard_shares
      ADD CONSTRAINT dashboard_shares_tenant_fkey
      FOREIGN KEY (tenant)
      REFERENCES tenants(tenant)
      ON DELETE CASCADE
  `);

  await addForeignKeyIfMissing(knex, 'dashboard_shares_dashboard_fkey', `
    ALTER TABLE dashboard_shares
      ADD CONSTRAINT dashboard_shares_dashboard_fkey
      FOREIGN KEY (tenant, dashboard_id)
      REFERENCES dashboards(tenant, dashboard_id)
      ON DELETE CASCADE
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('dashboard_shares');
  await knex.schema.dropTableIfExists('dashboards');
};

// Citus requires FK manipulation to run outside a transaction block.
exports.config = { transaction: false };
