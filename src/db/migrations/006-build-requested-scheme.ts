import type { Migration } from './types';

export const buildRequestedSchemeMigration: Migration = {
  version: 6,
  name: 'build_requested_scheme',
  up(database) {
    database.exec(`
      ALTER TABLE build_records ADD COLUMN requested_scheme TEXT;
    `);
  },
};
