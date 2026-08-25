import { describe, expect, it } from 'vitest'
import { parseBuild, parseProject, parseProjectSetup, parseRepositoryChoice, parseRepositoryDiscovery, parseSigningDiscovery, parseSigningProfileImport } from './schemas'

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
        { bundle_id: 'com.example.app', profile_name: 'Example App AdHoc', profile_uuid: '11111111-1111-4111-8111-111111111111' },
      ],
      lark_notification_chat_id: 'oc_manual_app_group',
    })).toMatchObject({
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: '11111111-1111-4111-8111-111111111111' },
      ],
      larkNotificationChatId: 'oc_manual_app_group',
    })
  })
})

describe('project setup API parsing', () => {
  it('parses setup outcome, validation, and the refreshed project', () => {
    expect(parseProjectSetup({
      setup: { dependenciesInstalled: false },
      validation: { valid: true, message: 'Project configuration is valid', canonicalRepoPath: '/repos/app' },
      project: {
        projectKey: 'app', displayName: 'App', repoPath: '/repos/app', fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:app', firebaseTesterGroups: ['qa'], firebaseCliTokenEnvVar: 'TOKEN',
        enabled: false, version: 1, validationStatus: 'valid',
      },
    })).toMatchObject({
      dependenciesInstalled: false,
      validation: { valid: true, canonicalRepoPath: '/repos/app' },
      project: { projectKey: 'app', validationStatus: 'valid' },
    })
  })
})

describe('repository discovery API parsing', () => {
  const validDiscovery = {
    repositories: [{
      path: '/Users/runner/repos/ios-app',
      name: 'ios-app',
      rootPath: '/Users/runner/repos',
      relativePath: 'ios-app',
      displayLabel: 'ios-app — /Users/runner/repos/ios-app',
      hasGit: true,
    }],
    warnings: [{
      code: 'REPOSITORY_ROOT_UNAVAILABLE',
      message: 'Repository root is unavailable.',
      rootPath: '/Volumes/mobile',
    }],
    truncated: true,
  }

  it('strictly parses repository candidates, warnings, and truncation metadata', () => {
    expect(parseRepositoryDiscovery(validDiscovery)).toEqual(validDiscovery)
    expect(parseRepositoryDiscovery({
      ...validDiscovery,
      repositories: [{
        ...validDiscovery.repositories[0],
        path: '/Users/runner/repos',
        name: 'repos',
        relativePath: '',
      }],
    }).repositories[0].relativePath).toBe('')
    expect(() => parseRepositoryDiscovery({ ...validDiscovery, unexpected: true })).toThrow()
    expect(() => parseRepositoryDiscovery({
      ...validDiscovery,
      repositories: [{ ...validDiscovery.repositories[0], unexpected: true }],
    })).toThrow()
    expect(() => parseRepositoryDiscovery({
      ...validDiscovery,
      repositories: [{ ...validDiscovery.repositories[0], path: 'relative/ios-app' }],
    })).toThrow()
    expect(() => parseRepositoryDiscovery({
      ...validDiscovery,
      warnings: [{ ...validDiscovery.warnings[0], unexpected: true }],
    })).toThrow()
  })

  it('strictly unwraps one canonical repository chooser result', () => {
    const repository = validDiscovery.repositories[0]
    expect(parseRepositoryChoice({ repository })).toEqual(repository)
    const trailingWhitespacePath = { ...repository, path: '/Users/runner/repos/ios-app ' }
    expect(parseRepositoryChoice({ repository: trailingWhitespacePath }).path).toBe(trailingWhitespacePath.path)
    expect(() => parseRepositoryChoice(repository)).toThrow()
    expect(() => parseRepositoryChoice({ repository, unexpected: true })).toThrow()
    expect(() => parseRepositoryChoice({ repository: { ...repository, path: 'relative/ios-app' } })).toThrow()
  })
})

describe('signing discovery API parsing', () => {
  const validDiscovery = {
    bundleId: 'com.example.app',
    profiles: [{
      profileName: 'Example App AdHoc',
      uuid: 'profile-uuid',
      teamId: 'AB12CDEFGH',
      teamName: 'Example Team',
      expiresAt: '2027-08-17T00:00:00.000Z',
      certificateCandidates: [{
        name: 'Apple Distribution: Example Team',
        sha1Fingerprint: 'A'.repeat(40),
        kind: 'distribution',
      }],
      recommendedCertificate: {
        name: 'Apple Distribution: Example Team',
        sha1Fingerprint: 'A'.repeat(40),
        kind: 'distribution',
      },
      warnings: [],
    }],
    warnings: [{ code: 'PROFILE_EXPIRES_SOON', message: 'Profile expires soon' }],
  }

  it('strictly parses the complete discovery contract', () => {
    expect(parseSigningDiscovery(validDiscovery)).toEqual(validDiscovery)
    expect(() => parseSigningDiscovery({ ...validDiscovery, unexpected: true })).toThrow()
    expect(() => parseSigningDiscovery({
      ...validDiscovery,
      profiles: [{ ...validDiscovery.profiles[0], unexpected: true }],
    })).toThrow()
    expect(() => parseSigningDiscovery({
      ...validDiscovery,
      profiles: [{
        ...validDiscovery.profiles[0],
        certificateCandidates: [{ ...validDiscovery.profiles[0].certificateCandidates[0], sha1Fingerprint: 'a'.repeat(40) }],
      }],
    })).toThrow()
  })

  it('strictly parses the imported profile UUID with the discovery result', () => {
    const validImport = { ...validDiscovery, importedProfileUuid: 'profile-uuid' }
    expect(parseSigningProfileImport(validImport)).toEqual(validImport)
    expect(() => parseSigningProfileImport(validDiscovery)).toThrow()
    expect(() => parseSigningProfileImport({ ...validImport, importedProfileUuid: '' })).toThrow()
    expect(() => parseSigningProfileImport({ ...validImport, unexpected: true })).toThrow()
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
