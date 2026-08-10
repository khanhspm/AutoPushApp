import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildJobDataV3 } from '../src/domain/build';
import { sendLarkTextMessage } from '../src/services/lark-service';
import { notificationChatIdFor, notifyBuildFailed, notifyBuildSucceeded } from '../src/services/notification';

vi.mock('../src/services/lark-service', () => ({
  sendLarkTextMessage: vi.fn(),
}));

function job(
  source: 'cms' | 'lark',
  projectChatId?: string | null,
  sourceChatId?: string | null,
  appVersion: string | null = '1.1',
): BuildJobDataV3 {
  return {
    schemaVersion: 3,
    buildId: 'build-1',
    config: {
      schemaVersion: 2,
      projectKey: 'my-app',
      displayName: 'My App',
      repoPath: '/tmp/my-app',
      fastlaneLane: 'distribute',
      scheme: 'MyApp',
      buildConfiguration: 'Release',
      firebaseAppId: '1:123:ios:abc',
      firebaseTesterGroups: ['qa'],
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'My App AdHoc' }],
      larkNotificationChatId: projectChatId,
      secretEnvRefs: { firebaseCliToken: 'MYAPP_FIREBASE_TOKEN' },
      projectVersion: 1,
    },
    request: {
      appVersion,
      buildNumber: '6',
      releaseNotes: '',
      source,
      requestedBy: source === 'lark' ? 'ou_builder' : 'cms-admin',
      chatId: sourceChatId,
    },
  };
}

describe('project Lark notification routing', () => {
  beforeEach(() => {
    vi.mocked(sendLarkTextMessage).mockReset().mockResolvedValue(undefined);
  });

  it('routes CMS builds to the configured project group', () => {
    expect(notificationChatIdFor(job('cms', 'oc_project_group'))).toBe('oc_project_group');
  });

  it('prefers the project group over the Lark command source chat', () => {
    expect(notificationChatIdFor(job('lark', 'oc_project_group', 'oc_source_group'))).toBe('oc_project_group');
  });

  it('falls back to the Lark command source chat', () => {
    expect(notificationChatIdFor(job('lark', null, 'oc_source_group'))).toBe('oc_source_group');
  });

  it('does not notify for CMS builds without a configured group', () => {
    expect(notificationChatIdFor(job('cms', null))).toBeNull();
  });

  it('sends exact terminal-only success and failure messages', async () => {
    const build = job('cms', 'oc_project_group');

    await notifyBuildSucceeded(build);
    await notifyBuildFailed(build);

    expect(sendLarkTextMessage).toHaveBeenNthCalledWith(
      1,
      'oc_project_group',
      'Đã có bản build 1.1 (6) trên Firebase.',
    );
    expect(sendLarkTextMessage).toHaveBeenNthCalledWith(
      2,
      'oc_project_group',
      'build failed 1.1 (6)',
    );
    expect(sendLarkTextMessage).toHaveBeenCalledTimes(2);
  });

  it('suppresses terminal messages for historical builds without an app version', async () => {
    const build = job('cms', 'oc_project_group', null, null);

    await notifyBuildSucceeded(build);
    await notifyBuildFailed(build);

    expect(sendLarkTextMessage).not.toHaveBeenCalled();
  });

  it('keeps legacy snapshots on the Lark source-chat fallback', () => {
    const legacyJob: BuildJobDataV3 = {
      ...job('lark', null, 'oc_source_group'),
      config: {
        schemaVersion: 1,
        projectKey: 'legacy-app',
        displayName: 'Legacy App',
        repoPath: '/tmp/legacy-app',
        fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:legacy',
        firebaseTesterGroups: ['qa'],
        secretEnvRefs: { firebaseCliToken: 'LEGACY_FIREBASE_TOKEN' },
        projectVersion: 1,
      },
    };

    expect(notificationChatIdFor(legacyJob)).toBe('oc_source_group');
  });
});
