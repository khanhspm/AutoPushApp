import type { Migration } from './types';

export const buildAppVersionMigration: Migration = {
  version: 5,
  name: 'build_app_version',
  up(database) {
    database.exec(`
      ALTER TABLE build_records ADD COLUMN app_version TEXT;
    `);
  },
};
