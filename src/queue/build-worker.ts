import path from 'node:path';

import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import type { BuildJobDataV3, BuildRecord } from '../domain/build';
import { BuildRepository } from '../repositories/build-repository';
import { BuildLogService } from '../services/build-log-service';
import { triggerFastlane } from '../services/fastlane-service';
import { notifyBuildFailed, notifyBuildSucceeded } from '../services/notification';
import { logger } from '../utils/logger';
import { BUILD_QUEUE_NAME } from './build-queue';

export interface WorkerHeartbeat {
  setCurrentBuild(buildId: string | null): Promise<void>;
}

export interface BuildProcessorDependencies {
  builds: BuildRepository;
  logs: BuildLogService;
  heartbeat?: WorkerHeartbeat;
}

export function canonicalBuildJobData(build: BuildRecord): BuildJobDataV3 {
  return {
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
}

export function executionConfigFor(job: BuildJobDataV3): BuildJobDataV3['config'] {
  return {
    ...job.config,
    scheme: job.request.scheme ?? job.config.scheme,
  };
}

export function createBuildProcessor(dependencies: BuildProcessorDependencies) {
  return async function processBuild(job: Job<BuildJobDataV3>): Promise<void> {
    const data = job.data;
    if (data.schemaVersion !== 3) {
      throw new Error(`Unsupported build payload schema ${String(data.schemaVersion)}`);
    }

    const current = dependencies.builds.findById(data.buildId);
    if (!current) {
      throw new Error(`Build record ${data.buildId} does not exist`);
    }
    if (current.status === 'success' || current.status === 'failed') {
      logger.warn({ jobId: job.id, buildId: data.buildId, status: current.status }, 'Ignoring terminal build job');
      return;
    }

    const canonicalData = canonicalBuildJobData(current);
    if (current.status === 'running') {
      const interruptionError = new Error('Worker restarted while this build was running; manual retry is required');
      if (dependencies.builds.markFailed(data.buildId, interruptionError.message, 'interrupted', ['running'])) {
        await notifyBuildFailed(canonicalData).catch((error) => {
          logger.error({ buildId: canonicalData.buildId, error }, 'Failed to send interrupted-build notification');
        });
      }
      return;
    }
    if (!dependencies.builds.claimRunning(data.buildId)) {
      throw new Error(`Build ${data.buildId} could not transition to running`);
    }

    const attempt = current.attemptCount + 1;
    const executionConfig = executionConfigFor(canonicalData);
    await dependencies.heartbeat?.setCurrentBuild(canonicalData.buildId);

    try {
      const result = await triggerFastlane(
        {
          buildId: canonicalData.buildId,
          attempt,
          appVersion: canonicalData.request.appVersion,
          buildNumber: canonicalData.request.buildNumber,
          releaseNotes: canonicalData.request.releaseNotes,
          config: executionConfig,
        },
        dependencies.logs,
      );

      dependencies.builds.markSuccess(canonicalData.buildId, result.logRelativePath);
      await notifyBuildSucceeded(canonicalData).catch((error) => {
        logger.error({ buildId: canonicalData.buildId, error }, 'Failed to send build-success notification');
      });
      logger.info({ jobId: job.id, buildId: canonicalData.buildId }, 'Build job succeeded');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const expectedLogPath = path.join(canonicalData.buildId, `attempt-${attempt}.log`);
      dependencies.builds.markFailed(canonicalData.buildId, errorMessage.slice(0, 1000), 'build', ['running'], expectedLogPath);
      await notifyBuildFailed(canonicalData).catch((notificationError) => {
        logger.error({ buildId: canonicalData.buildId, error: notificationError }, 'Failed to send build-failed notification');
      });
      logger.error({ jobId: job.id, buildId: canonicalData.buildId, error }, 'Build job failed');
      throw error;
    } finally {
      await dependencies.heartbeat?.setCurrentBuild(null);
    }
  };
}

export function createBuildWorker(
  connection: IORedis,
  dependencies: BuildProcessorDependencies,
): Worker<BuildJobDataV3> {
  const worker = new Worker<BuildJobDataV3>(BUILD_QUEUE_NAME, createBuildProcessor(dependencies), {
    connection,
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, buildId: job?.data.buildId, error }, 'Build worker failed job');
  });
  worker.on('error', (error) => {
    logger.error({ error }, 'Build worker error');
  });

  return worker;
}
