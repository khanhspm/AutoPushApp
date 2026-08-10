import type { BuildJobDataV3 } from '../domain/build';
import { logger } from '../utils/logger';
import { sendLarkTextMessage } from './lark-service';

export function notificationChatIdFor(job: BuildJobDataV3): string | null {
  const projectChatId = job.config.schemaVersion === 2 ? job.config.larkNotificationChatId : null;
  return projectChatId
    ?? (job.request.source === 'lark' ? job.request.chatId ?? null : null);
}

function releaseVersionFor(job: BuildJobDataV3): string | null {
  const appVersion = job.request.appVersion?.trim();
  if (appVersion) {
    return `${appVersion} (${job.request.buildNumber})`;
  }

  logger.warn({ buildId: job.buildId }, 'Skipping terminal Lark notification because app version is unavailable');
  return null;
}

export async function notifyBuildSucceeded(job: BuildJobDataV3): Promise<void> {
  const chatId = notificationChatIdFor(job);
  if (!chatId) return;

  const releaseVersion = releaseVersionFor(job);
  if (!releaseVersion) return;

  await sendLarkTextMessage(chatId, `Đã có bản build ${releaseVersion} trên Firebase.`);
}

export async function notifyBuildFailed(job: BuildJobDataV3): Promise<void> {
  const chatId = notificationChatIdFor(job);
  if (!chatId) return;

  const releaseVersion = releaseVersionFor(job);
  if (!releaseVersion) return;

  await sendLarkTextMessage(chatId, `build failed ${releaseVersion}`);
}
