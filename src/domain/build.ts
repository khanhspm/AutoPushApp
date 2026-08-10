import type { ProjectConfigSnapshot } from './project';

export const BUILD_STATUSES = ['enqueueing', 'queued', 'running', 'success', 'failed'] as const;
export const BUILD_SOURCES = ['cms', 'lark'] as const;

export type BuildStatus = (typeof BUILD_STATUSES)[number];
export type BuildSource = (typeof BUILD_SOURCES)[number];

export interface BuildRequestSnapshot {
  appVersion?: string | null;
  scheme?: string | null;
  buildNumber: string;
  releaseNotes: string;
  source: BuildSource;
  requestedBy: string;
  chatId?: string | null;
}

export interface BuildJobDataV3 {
  schemaVersion: 3;
  buildId: string;
  config: ProjectConfigSnapshot;
  request: BuildRequestSnapshot;
}

export interface BuildRecordRow {
  id: string;
  project_id: string | null;
  project_key_snapshot: string;
  project_name_snapshot: string;
  app_version: string | null;
  requested_scheme: string | null;
  build_number: string;
  release_notes: string;
  source: BuildSource;
  requested_by: string;
  chat_id: string | null;
  idempotency_key: string;
  queue_job_id: string | null;
  status: BuildStatus;
  failure_phase: string | null;
  config_snapshot_json: string;
  retry_of_id: string | null;
  attempt_count: number;
  log_rel_path: string | null;
  error_message: string | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildRecord {
  id: string;
  projectId: string | null;
  projectKey: string;
  projectName: string;
  appVersion: string | null;
  requestedScheme: string | null;
  buildNumber: string;
  releaseNotes: string;
  source: BuildSource;
  requestedBy: string;
  chatId: string | null;
  idempotencyKey: string;
  queueJobId: string | null;
  status: BuildStatus;
  failurePhase: string | null;
  configSnapshot: ProjectConfigSnapshot;
  retryOfId: string | null;
  attemptCount: number;
  logRelativePath: string | null;
  errorMessage: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildListOptions {
  projectKey?: string;
  status?: BuildStatus;
  source?: BuildSource;
  limit?: number;
  cursor?: string;
}

export interface BuildDashboardSummary {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  last24HoursSuccess: number;
  last24HoursFailed: number;
  recentBuilds: BuildRecord[];
}
