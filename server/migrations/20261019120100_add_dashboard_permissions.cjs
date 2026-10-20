/**
 * Provision the widget-dashboard permissions for every tenant.
 *
 * Declared in the unified catalog (server/migrations/utils/permissions/catalog.cjs)
 * with their default-role grants:
 *
 *   - `dashboard:share`  → share a dashboard you own with users and teams.
 *                          PSA: msp:Admin only.
 *   - `dashboard:manage` → act as owner on any dashboard (fix shares, transfer,
 *                          delete). PSA: msp:Admin only.
 *
 * No permission is needed to create, edit or delete one's own dashboards.
 *
 * Additive only: inserts the missing permissions and default-role grants and
 * never deletes. A tenant whose own shape blocks reconciliation is reported and
 * skipped, never fatal. See ./utils/permissions/reconcileTenants.cjs.
 */

const { reconcileAllTenants } = require('./utils/permissions/reconcileTenants.cjs');

exports.up = async function up(knex) {
  await reconcileAllTenants(knex, { label: 'add_dashboard_permissions' });
};

exports.down = async function down() {
  throw new Error(
    'add_dashboard_permissions is irreversible. Removing the permissions and their grants would delete '
    + 'state tenants may have assigned to custom roles since. Retiring a permission requires its own reviewed '
    + 'migration — see server/migrations/utils/permissions/README.md.',
  );
};

exports.config = { transaction: false };
