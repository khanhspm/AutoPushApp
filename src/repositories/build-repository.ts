import type { AppDatabase } from '../db/database';
import type {
  BuildDashboardSummary,
  BuildListOptions,
  BuildRecord,
  BuildRecordRow,
  BuildRequestSnapshot,
  BuildStatus,
} from '../domain/build';
import type { ProjectConfigSnapshot } from '../domain/project';

export interface CreateBuildRecordInput {
  id: string;
  projectId: string;
  config: ProjectConfigSnapshot;
  request: BuildRequestSnapshot;
  idempotencyKey: string;
  retryOfId?: string | null;
}

export interface BuildListResult {
  builds: BuildRecord[];
  nextCursor: string | null;
}

function mapBuild(row: BuildRecordRow): BuildRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key_snapshot,
    projectName: row.project_name_snapshot,
    appVersion: row.app_version,
    requestedScheme: row.requested_scheme,
    buildNumber: row.build_number,
    releaseNotes: row.release_notes,
    source: row.source,
    requestedBy: row.requested_by,
    chatId: row.chat_id,
    idempotencyKey: row.idempotency_key,
    queueJobId: row.queue_job_id,
    status: row.status,
    failurePhase: row.failure_phase,
    configSnapshot: JSON.parse(row.config_snapshot_json) as ProjectConfigSnapshot,
    retryOfId: row.retry_of_id,
    attemptCount: row.attempt_count,
    logRelativePath: row.log_rel_path,
    errorMessage: row.error_message,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(build: BuildRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: build.createdAt, id: build.id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    createdAt?: unknown;
    id?: unknown;
  };

  if (typeof value.createdAt !== 'string' || typeof value.id !== 'string') {
    throw new Error('Invalid build cursor');
  }

  return { createdAt: value.createdAt, id: value.id };
}

export class BuildRepository {
  constructor(private readonly database: AppDatabase) {}

  findById(id: string): BuildRecord | null {
    const row = this.database.prepare('SELECT * FROM build_records WHERE id = ?').get(id) as BuildRecordRow | undefined;
    return row ? mapBuild(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): BuildRecord | null {
    const row = this.database
      .prepare('SELECT * FROM build_records WHERE idempotency_key = ?')
      .get(idempotencyKey) as BuildRecordRow | undefined;
    return row ? mapBuild(row) : null;
  }

  createEnqueueing(input: CreateBuildRecordInput): BuildRecord {
    this.database
      .prepare(`
        INSERT INTO build_records (
          id, project_id, project_key_snapshot, project_name_snapshot, app_version, requested_scheme, build_number,
          release_notes, source, requested_by, chat_id, idempotency_key, status,
          config_snapshot_json, retry_of_id
        ) VALUES (
          @id, @projectId, @projectKey, @projectName, @appVersion, @requestedScheme, @buildNumber,
          @releaseNotes, @source, @requestedBy, @chatId, @idempotencyKey, 'enqueueing',
          @configSnapshot, @retryOfId
        )
      `)
      .run({
        id: input.id,
        projectId: input.projectId,
        projectKey: input.config.projectKey,
        projectName: input.config.displayName,
        appVersion: input.request.appVersion ?? null,
        requestedScheme: input.request.scheme ?? null,
        buildNumber: input.request.buildNumber,
        releaseNotes: input.request.releaseNotes,
        source: input.request.source,
        requestedBy: input.request.requestedBy,
        chatId: input.request.chatId ?? null,
        idempotencyKey: input.idempotencyKey,
        configSnapshot: JSON.stringify(input.config),
        retryOfId: input.retryOfId ?? null,
      });
    return this.findById(input.id)!;
  }

  markQueued(id: string, queueJobId: string): boolean {
    return (
      this.database
        .prepare(`
          UPDATE build_records
          SET status = 'queued', queue_job_id = ?, queued_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'enqueueing'
        `)
        .run(queueJobId, id).changes === 1
    );
  }

  markEnqueueFailed(id: string, message: string): boolean {
    return this.markFailed(id, message, 'enqueue', ['enqueueing']);
  }

  claimRunning(id: string): boolean {
    return (
      this.database
        .prepare(`
          UPDATE build_records
          SET status = 'running', attempt_count = attempt_count + 1,
              queued_at = COALESCE(queued_at, CURRENT_TIMESTAMP),
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('enqueueing', 'queued')
        `)
        .run(id).changes === 1
    );
  }

  markSuccess(id: string, logRelativePath: string): boolean {
    return (
      this.database
        .prepare(`
          UPDATE build_records
          SET status = 'success', log_rel_path = ?, error_message = NULL,
              finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
        `)
        .run(logRelativePath, id).changes === 1
    );
  }

  markFailed(
    id: string,
    message: string,
    failurePhase = 'build',
    allowedStatuses: BuildStatus[] = ['running'],
    logRelativePath?: string | null,
  ): boolean {
    const placeholders = allowedStatuses.map(() => '?').join(', ');
    return (
      this.database
        .prepare(`
          UPDATE build_records
          SET status = 'failed', failure_phase = ?, error_message = ?,
              log_rel_path = COALESCE(?, log_rel_path), finished_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN (${placeholders})
        `)
        .run(failurePhase, message, logRelativePath ?? null, id, ...allowedStatuses).changes === 1
    );
  }

  list(options: BuildListOptions = {}): BuildListResult {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const where: string[] = [];
    const parameters: unknown[] = [];

    if (options.projectKey) {
      where.push('project_key_snapshot = ? COLLATE NOCASE');
      parameters.push(options.projectKey);
    }
    if (options.status) {
      where.push('status = ?');
      parameters.push(options.status);
    }
    if (options.source) {
      where.push('source = ?');
      parameters.push(options.source);
    }
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = this.database
      .prepare(`
        SELECT * FROM build_records
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters, limit + 1) as BuildRecordRow[];
    const records = rows.slice(0, limit).map(mapBuild);

    return {
      builds: records,
      nextCursor: rows.length > limit && records.length ? encodeCursor(records[records.length - 1]) : null,
    };
  }

  dashboard(): BuildDashboardSummary {
    const counts = this.database
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status IN ('enqueueing', 'queued') THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'success' AND created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24HoursSuccess,
          SUM(CASE WHEN status = 'failed' AND created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24HoursFailed
        FROM build_records
      `)
      .get() as Omit<BuildDashboardSummary, 'recentBuilds'>;

    return {
      ...counts,
      total: counts.total ?? 0,
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      success: counts.success ?? 0,
      failed: counts.failed ?? 0,
      last24HoursSuccess: counts.last24HoursSuccess ?? 0,
      last24HoursFailed: counts.last24HoursFailed ?? 0,
      recentBuilds: this.list({ limit: 10 }).builds,
    };
  }

  listStaleEnqueueing(ageSeconds = 30): BuildRecord[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM build_records
        WHERE status = 'enqueueing' AND created_at <= datetime('now', ?)
        ORDER BY created_at
      `)
      .all(`-${Math.max(1, Math.trunc(ageSeconds))} seconds`) as BuildRecordRow[];
    return rows.map(mapBuild);
  }
}
