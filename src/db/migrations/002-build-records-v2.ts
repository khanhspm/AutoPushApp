import crypto from 'node:crypto';

import type { BuildStatus } from '../../domain/build';
import type { ProjectConfigSnapshotV1 } from '../../domain/project';
import type { AppDatabase } from '../database';
import type { Migration } from './types';

interface TableInfoRow {
  name: string;
}

interface LegacyBuildRecordRow {
  id: number;
  project_id: string;
  build_number: string;
  release_notes: string;
  requested_by: string;
  chat_id: string;
  status: string;
  log_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const V2_COLUMNS = new Set([
  'id',
  'project_key_snapshot',
  'project_name_snapshot',
  'config_snapshot_json',
  'idempotency_key',
  'source',
]);

function tableExists(database: AppDatabase, tableName: string): boolean {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

function getColumnNames(database: AppDatabase, tableName: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${tableName}")`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function createBuildRecordsTable(database: AppDatabase, tableName = 'build_records'): void {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      project_id TEXT COLLATE NOCASE,
      project_key_snapshot TEXT NOT NULL,
      project_name_snapshot TEXT NOT NULL,
      build_number TEXT NOT NULL,
      release_notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('cms', 'lark')),
      requested_by TEXT NOT NULL,
      chat_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      queue_job_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('enqueueing', 'queued', 'running', 'success', 'failed')),
      failure_phase TEXT,
      config_snapshot_json TEXT NOT NULL,
      retry_of_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      log_rel_path TEXT,
      error_message TEXT,
      queued_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(project_key) ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (retry_of_id) REFERENCES build_records(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_build_records_created_at
      ON ${tableName}(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_build_records_project_created_at
      ON ${tableName}(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_build_records_status_created_at
      ON ${tableName}(status, created_at DESC, id DESC);
  `);
}

function normalizeLegacyStatus(status: string): BuildStatus {
  if (status === 'queued' || status === 'running' || status === 'success' || status === 'failed') {
    return status;
  }

  return status === 'succeeded' || status === 'completed' ? 'success' : 'failed';
}

function legacySnapshot(projectId: string): ProjectConfigSnapshotV1 {
  return {
    schemaVersion: 1,
    projectKey: projectId,
    displayName: projectId,
    repoPath: '',
    fastlaneLane: 'distribute',
    scheme: projectId,
    buildConfiguration: null,
    firebaseAppId: '',
    firebaseTesterGroups: [],
    secretEnvRefs: { firebaseCliToken: 'LEGACY_FIREBASE_CLI_TOKEN' },
    projectVersion: 1,
  };
}

function migrateLegacyBuildRecords(database: AppDatabase): void {
  const rows = database.prepare('SELECT * FROM build_records ORDER BY id').all() as LegacyBuildRecordRow[];

  database.exec(`
    DROP INDEX IF EXISTS idx_build_records_created_at;
    DROP INDEX IF EXISTS idx_build_records_project_created_at;
    DROP INDEX IF EXISTS idx_build_records_status_created_at;
    ALTER TABLE build_records RENAME TO build_records_legacy_v1;
  `);
  createBuildRecordsTable(database);

  const insertProject = database.prepare(`
    INSERT OR IGNORE INTO projects (
      project_key, display_name, repo_path, fastlane_lane, scheme, firebase_app_id,
      firebase_cli_token_env_var, enabled, validation_status, validation_message
    ) VALUES (?, ?, '', 'distribute', ?, '', 'LEGACY_FIREBASE_CLI_TOKEN', 0, 'invalid', 'Migrated legacy project; configure it in the CMS')
  `);
  const insertUser = database.prepare(`
    INSERT OR IGNORE INTO users (id, display_name, enabled) VALUES (?, ?, 1)
  `);
  const insertBuild = database.prepare(`
    INSERT INTO build_records (
      id, project_id, project_key_snapshot, project_name_snapshot, build_number,
      release_notes, source, requested_by, chat_id, idempotency_key, status,
      failure_phase, config_snapshot_json, attempt_count, log_rel_path,
      error_message, queued_at, started_at, finished_at, created_at, updated_at
    ) VALUES (
      @id, @projectId, @projectId, @projectId, @buildNumber,
      @releaseNotes, 'lark', @requestedBy, @chatId, @idempotencyKey, @status,
      @failurePhase, @snapshot, @attemptCount, NULL,
      @errorMessage, @queuedAt, @startedAt, @finishedAt, @createdAt, @updatedAt
    )
  `);

  for (const row of rows) {
    const status = normalizeLegacyStatus(row.status);
    insertProject.run(row.project_id, row.project_id, row.project_id);
    insertUser.run(row.requested_by, row.requested_by);
    insertBuild.run({
      id: `legacy-${row.id}-${crypto.randomUUID()}`,
      projectId: row.project_id,
      buildNumber: row.build_number,
      releaseNotes: row.release_notes,
      requestedBy: row.requested_by,
      chatId: row.chat_id,
      idempotencyKey: `legacy:${row.id}`,
      status,
      failurePhase: status === 'failed' ? 'legacy' : null,
      snapshot: JSON.stringify(legacySnapshot(row.project_id)),
      attemptCount: status === 'queued' ? 0 : 1,
      errorMessage: row.error_message,
      queuedAt: row.created_at,
      startedAt: status === 'queued' ? null : row.created_at,
      finishedAt: status === 'success' || status === 'failed' ? row.updated_at : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  database.exec('DROP TABLE build_records_legacy_v1');
}

export const buildRecordsV2Migration: Migration = {
  version: 2,
  name: 'build_records_v2',
  up(database) {
    if (!tableExists(database, 'build_records')) {
      createBuildRecordsTable(database);
      return;
    }

    const columns = getColumnNames(database, 'build_records');
    if ([...V2_COLUMNS].every((column) => columns.has(column))) {
      return;
    }

    migrateLegacyBuildRecords(database);
  },
};
