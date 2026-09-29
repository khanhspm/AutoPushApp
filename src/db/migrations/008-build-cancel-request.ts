import type { Migration } from './types';

export const buildCancelRequestMigration: Migration = {
  version: 8,
  name: 'build_cancel_request',
  up(database) {
    database.exec('ALTER TABLE build_records ADD COLUMN cancel_requested_at TEXT');
  },
};
