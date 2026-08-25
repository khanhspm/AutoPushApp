import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectConfigSnapshotV1, ProjectConfigSnapshotV2 } from '../src/domain/project';
import { createChildEnvironment, createFastlaneRunnerArgs } from '../src/services/fastlane-service';

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe('Fastlane signing environment', () => {
  it('injects manual signing configuration without resolving Match credentials', () => {
    process.env.APP_FIREBASE_TOKEN = 'firebase-secret';
    process.env.BUNDLE_BIN = '/opt/homebrew/bin/bundle';
    process.env.BUNDLE_GEMFILE = '/tmp/autopush/Gemfile';

    const config: ProjectConfigSnapshotV2 = {
      schemaVersion: 2,
      projectKey: 'manual-app',
      displayName: 'Manual App',
      repoPath: '/tmp/manual-app',
      fastlaneLane: 'distribute',
      scheme: 'ManualApp',
      buildConfiguration: 'Release',
      firebaseAppId: '1:123:ios:abc',
      firebaseTesterGroups: ['qa'],
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: '11111111-1111-4111-8111-111111111111' },
        { bundleId: 'com.example.app.widget', profileName: 'Example Widget AdHoc' },
      ],
      secretEnvRefs: {
        firebaseCliToken: 'APP_FIREBASE_TOKEN',
        matchPassword: null,
        appStoreConnectKeyId: null,
        appStoreConnectIssuerId: null,
        appStoreConnectKeyPath: null,
      },
      projectVersion: 2,
    };

    const result = createChildEnvironment(config);

    expect(result.childEnv).toMatchObject({
      AUTOPUSH_SIGNING_MODE: 'manual',
      AUTOPUSH_APPLE_TEAM_ID: 'AB12CDEFGH',
      AUTOPUSH_SIGNING_CERTIFICATE: 'Apple Distribution',
      FIREBASE_CLI_TOKEN: 'firebase-secret',
      BUNDLE_BIN: '/opt/homebrew/bin/bundle',
    });
    expect(JSON.parse(result.childEnv.AUTOPUSH_PROVISIONING_PROFILES_JSON!)).toEqual(config.provisioningProfiles);
    expect(result.childEnv.MATCH_PASSWORD).toBeUndefined();
    expect(result.childEnv.APP_STORE_CONNECT_API_KEY_ID).toBeUndefined();
    expect(result.childEnv.BUNDLE_GEMFILE).toBeUndefined();
    expect(result.secretValues).toEqual(['firebase-secret']);
  });

  it('keeps manual export mappings on profile names instead of UUIDs', async () => {
    const template = await fs.readFile(path.resolve('fastlane/Fastfile.example'), 'utf8');

    expect(template).toContain('profiles[bundle_id] = profile_name');
    expect(template).not.toContain('profile_uuid.empty? ? profile_name : profile_uuid');
  });

  it('treats V1 snapshots as Match signing', () => {
    process.env.APP_FIREBASE_TOKEN = 'firebase-secret';
    process.env.APP_MATCH_PASSWORD = 'match-secret';
    process.env.APP_ASC_KEY_ID = 'key-id';
    process.env.APP_ASC_ISSUER_ID = 'issuer-id';
    process.env.APP_ASC_KEY_PATH = '/secure/AuthKey.p8';
    process.env.MATCH_GIT_BASIC_AUTHORIZATION = 'basic-auth-secret';
    process.env.MATCH_GIT_PRIVATE_KEY = '/secure/match-deploy-key';
    process.env.MATCH_KEYCHAIN_NAME = 'ci-signing.keychain-db';
    process.env.MATCH_KEYCHAIN_PASSWORD = 'keychain-secret';

    const config: ProjectConfigSnapshotV1 = {
      schemaVersion: 1,
      projectKey: 'match-app',
      displayName: 'Match App',
      repoPath: '/tmp/match-app',
      fastlaneLane: 'distribute',
      scheme: 'MatchApp',
      buildConfiguration: 'Release',
      firebaseAppId: '1:123:ios:def',
      firebaseTesterGroups: ['qa'],
      secretEnvRefs: {
        firebaseCliToken: 'APP_FIREBASE_TOKEN',
        matchPassword: 'APP_MATCH_PASSWORD',
        appStoreConnectKeyId: 'APP_ASC_KEY_ID',
        appStoreConnectIssuerId: 'APP_ASC_ISSUER_ID',
        appStoreConnectKeyPath: 'APP_ASC_KEY_PATH',
      },
      projectVersion: 1,
    };

    const result = createChildEnvironment(config);

    expect(result.childEnv).toMatchObject({
      AUTOPUSH_SIGNING_MODE: 'match',
      FIREBASE_CLI_TOKEN: 'firebase-secret',
      MATCH_PASSWORD: 'match-secret',
      APP_STORE_CONNECT_API_KEY_ID: 'key-id',
      APP_STORE_CONNECT_API_ISSUER_ID: 'issuer-id',
      APP_STORE_CONNECT_API_KEY_PATH: '/secure/AuthKey.p8',
      MATCH_GIT_BASIC_AUTHORIZATION: 'basic-auth-secret',
      MATCH_GIT_PRIVATE_KEY: '/secure/match-deploy-key',
      MATCH_KEYCHAIN_NAME: 'ci-signing.keychain-db',
      MATCH_KEYCHAIN_PASSWORD: 'keychain-secret',
    });
    expect(result.secretValues).toEqual(expect.arrayContaining(['basic-auth-secret', '/secure/match-deploy-key', 'keychain-secret']));
    expect(result.childEnv.AUTOPUSH_PROVISIONING_PROFILES_JSON).toBeUndefined();
  });

  it('passes app version separately as the final runner argument', () => {
    const config: ProjectConfigSnapshotV1 = {
      schemaVersion: 1,
      projectKey: 'app',
      displayName: 'App',
      repoPath: '/tmp/app',
      fastlaneLane: 'distribute',
      scheme: 'App',
      buildConfiguration: 'Release',
      firebaseAppId: '1:123:ios:app',
      firebaseTesterGroups: ['qa'],
      secretEnvRefs: { firebaseCliToken: 'APP_FIREBASE_TOKEN' },
      projectVersion: 1,
    };

    expect(createFastlaneRunnerArgs({
      buildId: 'build-1',
      attempt: 1,
      appVersion: '1.1',
      buildNumber: '6',
      releaseNotes: 'Test',
      config,
    })).toEqual([
      '/tmp/app',
      'distribute',
      '6',
      'Test',
      'App',
      'Release',
      '1:123:ios:app',
      'qa',
      '1.1',
    ]);
  });
});
