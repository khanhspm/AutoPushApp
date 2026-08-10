import crypto from 'node:crypto';

import { z } from 'zod';

import type { BuildJobDataV3, BuildRecord, BuildSource } from '../domain/build';
import { AppError } from '../http/errors';
import type { BuildQueueGateway } from '../queue/build-queue';
import { BuildRepository } from '../repositories/build-repository';
import { UserRepository } from '../repositories/user-repository';
import { logger } from '../utils/logger';
import { notifyBuildFailed } from './notification';
import { ProjectConfigService } from './project-config-service';

const appVersionSchema = z.string().trim().min(1).max(40).regex(/^\d+(?:\.\d+){0,2}$/);
const buildNumberSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/);
const schemeSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_. -]+$/);
const releaseNotesSchema = z.string().trim().max(10_000).default('');

export interface SubmitBuildInput {
  projectKey: string;
  appVersion?: string | null;
  scheme?: string | null;
  buildNumber: string;
  releaseNotes?: string;
  source: BuildSource;
  requestedBy: string;
  chatId?: string | null;
  idempotencyKey: string;
  retryOfId?: string | null;
}

export interface SubmitBuildResult {
  build: BuildRecord;
  created: boolean;
}

export class BuildRequestService {
  constructor(
    private readonly builds: BuildRepository,
    private readonly users: UserRepository,
    private readonly projects: ProjectConfigService,
    private readonly queue: BuildQueueGateway,
  ) {}

  async submit(input: SubmitBuildInput): Promise<SubmitBuildResult> {
    const existing = this.builds.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { build: existing, created: false };
    }

    const parsedAppVersion = appVersionSchema.safeParse(input.appVersion);
    if (!parsedAppVersion.success) {
      throw new AppError(400, 'APP_VERSION_INVALID', 'App version is required and must look like 1.1 or 1.1.0');
    }
    const appVersion = parsedAppVersion.data;
    const requestedScheme = input.source === 'cms' && input.scheme
      ? schemeSchema.parse(input.scheme)
      : null;
    const buildNumber = buildNumberSchema.parse(input.buildNumber);
    const releaseNotes = releaseNotesSchema.parse(input.releaseNotes ?? '');

    if (input.source === 'lark' && !this.users.canBuildProject(input.requestedBy, input.projectKey)) {
      throw new AppError(403, 'PROJECT_BUILD_FORBIDDEN', 'You do not have build permission for this project');
    }

    const config = await this.projects.resolveForBuild(input.projectKey);
    const buildId = crypto.randomUUID();
    const request = {
      appVersion,
      scheme: requestedScheme,
      buildNumber,
      releaseNotes,
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId ?? null,
    };

    let build: BuildRecord;
    try {
      build = this.builds.createEnqueueing({
        id: buildId,
        projectId: config.projectKey,
        config,
        request,
        idempotencyKey: input.idempotencyKey,
        retryOfId: input.retryOfId,
      });
    } catch (error) {
      const raced = this.builds.findByIdempotencyKey(input.idempotencyKey);
      if (raced) {
        return { build: raced, created: false };
      }
      throw error;
    }

    const jobData: BuildJobDataV3 = {
      schemaVersion: 3,
      buildId,
      config,
      request,
    };

    try {
      const job = await this.queue.enqueue(jobData);
      this.builds.markQueued(buildId, job.id);
      build = this.builds.findById(buildId)!;
      return { build, created: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.builds.markEnqueueFailed(buildId, message.slice(0, 500));
      await notifyBuildFailed(jobData).catch((notificationError) => {
        logger.error({ buildId, error: notificationError }, 'Failed to send enqueue-failed notification');
      });
      return { build: this.builds.findById(buildId)!, created: true };
    }
  }

  async retry(
    originalBuildId: string,
    idempotencyKey: string,
    requestedBy: string,
    overrides: { appVersion?: string; scheme?: string; buildNumber?: string; releaseNotes?: string } = {},
  ): Promise<SubmitBuildResult> {
    const existing = this.builds.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { build: existing, created: false };
    }

    const original = this.builds.findById(originalBuildId);
    if (!original) {
      throw new AppError(404, 'BUILD_NOT_FOUND', 'Build was not found');
    }
    if (['enqueueing', 'queued', 'running'].includes(original.status)) {
      throw new AppError(409, 'BUILD_ACTIVE', 'An active build cannot be retried');
    }

    return this.submit({
      projectKey: original.projectKey,
      appVersion: overrides.appVersion ?? original.appVersion,
      scheme: overrides.scheme ?? original.requestedScheme,
      buildNumber: overrides.buildNumber ?? original.buildNumber,
      releaseNotes: overrides.releaseNotes ?? original.releaseNotes,
      source: 'cms',
      requestedBy,
      idempotencyKey,
      retryOfId: original.id,
    });
  }

  async reconcileEnqueueing(): Promise<void> {
    for (const build of this.builds.listStaleEnqueueing()) {
      const job: BuildJobDataV3 = {
        schemaVersion: 3,
        buildId: build.id,
        config: build.configSnapshot,
        request: {
          appVersion: build.appVersion,
          scheme: build.requestedScheme,
          buildNumber: build.buildNumber,
          releaseNotes: build.releaseNotes,
          source: build.source,
          requestedBy: build.requestedBy,
          chatId: build.chatId,
        },
      };
      const existingJob = await this.queue.getJob(build.id);
      if (existingJob) {
        this.builds.markQueued(build.id, String(existingJob.id));
        continue;
      }

      try {
        const queued = await this.queue.enqueue(job);
        this.builds.markQueued(build.id, queued.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.builds.markEnqueueFailed(build.id, message.slice(0, 500));
        await notifyBuildFailed(job).catch((notificationError) => {
          logger.error({ buildId: build.id, error: notificationError }, 'Failed to send reconciled enqueue-failed notification');
        });
      }
    }
  }
}
