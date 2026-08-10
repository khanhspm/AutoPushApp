import { describe, expect, it } from 'vitest';

import { buildCommandHelp, parseBuildCommand } from '../src/commands/build-command';

describe('Lark build command', () => {
  it('parses app version and build number separately', () => {
    expect(parseBuildCommand('/build prank-call-ios 1.1 6 "Firebase release"')).toEqual({
      projectId: 'prank-call-ios',
      appVersion: '1.1',
      buildNumber: '6',
      releaseNotes: 'Firebase release',
    });
  });

  it('removes a Lark mention before parsing', () => {
    expect(parseBuildCommand('<at user_id="bot">AutoPush</at> /build MyApp 1.2.0 7 "Test"')).toMatchObject({
      projectId: 'MyApp',
      appVersion: '1.2.0',
      buildNumber: '7',
    });
  });

  it('rejects malformed app versions', () => {
    expect(parseBuildCommand('/build MyApp version-one 7 "Test"')).toBeNull();
  });

  it('recognizes the old quoted syntax for duplicate compatibility', () => {
    expect(parseBuildCommand('/build MyApp 7 "Legacy delivery"')).toEqual({
      projectId: 'MyApp',
      appVersion: null,
      buildNumber: '7',
      releaseNotes: 'Legacy delivery',
    });
  });

  it('documents the new syntax', () => {
    expect(buildCommandHelp()).toContain('/build <project_id> <app_version> <build_number>');
    expect(buildCommandHelp()).toContain('/build MyApp 1.1 6');
  });
});
