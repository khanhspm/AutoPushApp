import type { Migration } from './types';

export const coreEntitiesMigration: Migration = {
  version: 1,
  name: 'project_registry_and_users',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY COLLATE NOCASE,
        display_name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        fastlane_lane TEXT NOT NULL,
        scheme TEXT,
        build_configuration TEXT,
        firebase_app_id TEXT NOT NULL,
        firebase_tester_groups_json TEXT NOT NULL DEFAULT '[]',
        firebase_cli_token_env_var TEXT NOT NULL,
        match_password_env_var TEXT,
        app_store_connect_key_id_env_var TEXT,
        app_store_connect_issuer_id_env_var TEXT,
        app_store_connect_key_path_env_var TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        validation_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (validation_status IN ('unknown', 'valid', 'invalid')),
        validation_message TEXT,
        validated_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_projects_enabled_name
        ON projects(enabled, display_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_enabled_display_name
        ON users(enabled, display_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS project_user_permissions (
        project_id TEXT NOT NULL COLLATE NOCASE,
        user_id TEXT NOT NULL,
        can_build INTEGER NOT NULL DEFAULT 1 CHECK (can_build IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_key) ON UPDATE CASCADE ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_user_permissions_user
        ON project_user_permissions(user_id, project_id);
    `);
  },
};
