/**
 * asset_mac_addresses: the MAC addresses each RMM reports for an asset.
 *
 * Cross-RMM deduplication matches a newly seen device to an existing asset on
 * name + client + a shared MAC, so every provider records the MACs it sees
 * here (normalized aa:bb:cc:dd:ee:ff). One row per (asset, MAC, provider):
 * each provider replaces only its own set, so two RMMs reporting the same NIC
 * never clobber each other, and an asset row going away takes its MACs with it.
 */

const { ensureTenantDistribution, ensureCompositeFk } = require('./utils/citusDistribution.cjs');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('asset_mac_addresses'))) {
    await knex.schema.createTable('asset_mac_addresses', (table) => {
      table.uuid('tenant').notNullable();
      table.uuid('asset_id').notNullable();
      table.text('mac_address').notNullable();
      table.string('provider', 50).notNullable();
      table.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.primary(['tenant', 'asset_id', 'mac_address', 'provider']);
    });
    await knex.raw(`
      ALTER TABLE asset_mac_addresses
      ADD CONSTRAINT asset_mac_addresses_format_check
      CHECK (mac_address ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$')
    `);
    // The dedup lookup: which assets carry this MAC.
    await knex.raw('CREATE INDEX idx_asset_mac_addresses_mac ON asset_mac_addresses (tenant, mac_address)');
  }

  await ensureTenantDistribution(knex, 'asset_mac_addresses');
  await ensureCompositeFk(knex, {
    table: 'asset_mac_addresses',
    constraint: 'asset_mac_addresses_asset_fk',
    columns: ['tenant', 'asset_id'],
    referencedTable: 'assets',
    referencedColumns: ['tenant', 'asset_id'],
    onDelete: 'CASCADE',
  });
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_asset_mac_addresses_mac');
  await knex.schema.dropTableIfExists('asset_mac_addresses');
};

exports.config = { transaction: false };
