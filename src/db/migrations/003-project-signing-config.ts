import type { Migration } from './types';

export const projectSigningConfigMigration: Migration = {
  version: 3,
  name: 'project_signing_config',
  up(database) {
    database.exec(`
      ALTER TABLE projects ADD COLUMN signing_mode TEXT NOT NULL DEFAULT 'match'
        CHECK (signing_mode IN ('manual', 'match'));
      ALTER TABLE projects ADD COLUMN apple_team_id TEXT;
      ALTER TABLE projects ADD COLUMN signing_certificate TEXT NOT NULL DEFAULT 'Apple Distribution';
      ALTER TABLE projects ADD COLUMN provisioning_profiles_json TEXT NOT NULL DEFAULT '[]';
    `);
  },
};
