import { describe, expect, it } from 'vitest'
import { parseBuild, parseProject } from './schemas'

describe('project API parsing', () => {
  it('defaults legacy projects to Match signing', () => {
    expect(parseProject({
      projectKey: 'legacy',
      displayName: 'Legacy',
      repoPath: '/repos/legacy',
      fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:legacy',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'LEGACY_FIREBASE_TOKEN',
    })).toMatchObject({
      signingMode: 'match',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [],
    })
  })

  it('parses manual signing mappings from snake case responses', () => {
    expect(parseProject({
      project_key: 'manual',
      display_name: 'Manual',
      repo_path: '/repos/manual',
      fastlane_lane: 'distribute',
      firebase_app_id: '1:123:ios:manual',
      firebase_tester_groups: ['qa'],
      firebase_cli_token_env_var: 'MANUAL_FIREBASE_TOKEN',
      signing_mode: 'manual',
      apple_team_id: 'AB12CDEFGH',
      signing_certificate: 'Apple Distribution',
      provisioning_profiles: [
        { bundle_id: 'com.example.app', profile_name: 'Example App AdHoc' },
      ],
      lark_notification_chat_id: 'oc_manual_app_group',
    })).toMatchObject({
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'Example App AdHoc' },
      ],
      larkNotificationChatId: 'oc_manual_app_group',
    })
  })
})

describe('build API parsing', () => {
  it('parses modern app versions and preserves legacy null values', () => {
    expect(parseBuild({
      id: 'build-1', project_key: 'app', app_version: '1.1', requested_scheme: 'PrankCallDebug', build_number: '6',
      source: 'cms', status: 'success', created_at: '2026-08-07T00:00:00.000Z',
    })).toMatchObject({ appVersion: '1.1', requestedScheme: 'PrankCallDebug', buildNumber: '6' })

    expect(parseBuild({
      id: 'legacy-1', project_key: 'app', build_number: '5',
      source: 'cms', status: 'failed', created_at: '2026-08-06T00:00:00.000Z',
    })).toMatchObject({ appVersion: undefined, buildNumber: '5' })
  })
})
