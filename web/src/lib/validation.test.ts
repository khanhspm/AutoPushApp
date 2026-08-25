import { describe, expect, it } from 'vitest'
import { buildTriggerSchema, isConcreteBundleId, parseTesterGroups, projectFormSchema, userFormSchema } from './validation'

describe('frontend form validation', () => {
  it('rejects missing project delivery settings and unsafe env references', () => {
    const result = projectFormSchema.safeParse({
      projectKey: 'ios app', displayName: 'iOS App', repoPath: '', fastlaneLane: 'ios build',
      firebaseAppId: '', firebaseTesterGroupsText: '', firebaseCliTokenEnvVar: 'firebase-token', enabled: false,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.projectKey).toBeDefined()
      expect(result.error.flatten().fieldErrors.repoPath).toBeDefined()
      expect(result.error.flatten().fieldErrors.firebaseCliTokenEnvVar).toBeDefined()
    }
  })

  it('recognizes only concrete dotted bundle IDs for signing discovery', () => {
    expect(isConcreteBundleId(' com.example.app ')).toBe(true)
    expect(isConcreteBundleId('com.example.app-widget')).toBe(true)
    expect(isConcreteBundleId('com.example.*')).toBe(false)
    expect(isConcreteBundleId('*.example.app')).toBe(false)
    expect(isConcreteBundleId('com.example')).toBe(true)
    expect(isConcreteBundleId('com')).toBe(false)
    expect(isConcreteBundleId('com..example')).toBe(false)
    expect(isConcreteBundleId('com.example_app')).toBe(false)
  })

  it('accepts multiple manual profile mappings while ignoring inactive Match references', () => {
    const result = projectFormSchema.safeParse({
      projectKey: 'ios-app', displayName: 'iOS App', repoPath: '/repos/ios-app', fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:abc', firebaseTesterGroupsText: 'qa', firebaseCliTokenEnvVar: 'APP_FIREBASE_TOKEN',
      matchPasswordEnvVar: 'legacy-match', appStoreConnectKeyIdEnvVar: 'legacy-key',
      signingMode: 'manual', appleTeamId: 'AB12CDEFGH', signingCertificate: 'Apple Distribution',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'Example App AdHoc' },
        { bundleId: 'com.example.app.widget', profileName: 'Example Widget AdHoc' },
      ],
      larkNotificationChatId: 'oc_example_project_group',
      enabled: false,
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate manual bundle IDs and incomplete Match references', () => {
    const manual = projectFormSchema.safeParse({
      projectKey: 'ios-app', displayName: 'iOS App', repoPath: '/repos/ios-app', fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:abc', firebaseTesterGroupsText: 'qa', firebaseCliTokenEnvVar: 'APP_FIREBASE_TOKEN',
      signingMode: 'manual', appleTeamId: 'AB12CDEFGH', signingCertificate: 'Apple Distribution',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'One' },
        { bundleId: 'COM.EXAMPLE.APP', profileName: 'Two' },
      ],
      enabled: false,
    })
    const match = projectFormSchema.safeParse({
      projectKey: 'ios-app', displayName: 'iOS App', repoPath: '/repos/ios-app', fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:abc', firebaseTesterGroupsText: 'qa', firebaseCliTokenEnvVar: 'APP_FIREBASE_TOKEN',
      signingMode: 'match', signingCertificate: 'Apple Distribution', provisioningProfiles: [], enabled: true,
    })

    expect(manual.success).toBe(false)
    expect(match.success).toBe(false)
  })

  it('rejects malformed Lark notification chat IDs', () => {
    const result = projectFormSchema.safeParse({
      projectKey: 'ios-app', displayName: 'iOS App', repoPath: '/repos/ios-app', fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:abc', firebaseTesterGroupsText: 'qa', firebaseCliTokenEnvVar: 'APP_FIREBASE_TOKEN',
      signingMode: 'manual', appleTeamId: 'AB12CDEFGH', signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
      larkNotificationChatId: 'not-a-lark-chat', enabled: false,
    })
    expect(result.success).toBe(false)
  })

  it('requires a dotted numeric app version for builds', () => {
    expect(buildTriggerSchema.safeParse({ appVersion: '1.1', scheme: 'PrankCall', buildNumber: '6', releaseNotes: '' }).success).toBe(true)
    expect(buildTriggerSchema.safeParse({ appVersion: '', buildNumber: '6', releaseNotes: '' }).success).toBe(false)
    expect(buildTriggerSchema.safeParse({ appVersion: 'version-one', scheme: 'PrankCall', buildNumber: '6', releaseNotes: '' }).success).toBe(false)
    expect(buildTriggerSchema.safeParse({ appVersion: '1.1', scheme: 'Bad/Scheme', buildNumber: '6', releaseNotes: '' }).success).toBe(false)
  })

  it('normalizes tester groups and accepts a backend user shape', () => {
    expect(parseTesterGroups('qa, internal, qa')).toEqual(['qa', 'internal'])
    expect(userFormSchema.parse({ id: 'ou_123', displayName: ' Release Operator ', enabled: true })).toEqual({ id: 'ou_123', displayName: 'Release Operator', enabled: true })
  })
})
