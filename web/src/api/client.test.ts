import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'
import { getToken, setToken } from '../lib/auth'

describe('API authentication', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the bearer token and parses a session', async () => {
    setToken('admin-secret')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: { name: 'Ops Admin' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.getSession()).resolves.toMatchObject({ authenticated: true, user: { name: 'Ops Admin' } })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer admin-secret')
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin')
  })

  it('posts the native repository chooser request and parses its canonical choice', async () => {
    setToken('repository-admin')
    const repository = {
      path: '/Users/runner/repos/ios-app',
      name: 'ios-app',
      rootPath: '/Users/runner/repos',
      relativePath: 'ios-app',
      displayLabel: 'ios-app — /Users/runner/repos/ios-app',
      hasGit: true,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ repository }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.chooseRepository()).resolves.toEqual(repository)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/repositories/choose')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer repository-admin')
    expect(headers.has('Content-Type')).toBe(false)
  })

  it('returns null when the native repository chooser is cancelled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(api.chooseRepository()).resolves.toBeNull()
  })

  it('posts the concrete bundle ID with authentication and parses discovery', async () => {
    setToken('signing-admin')
    const payload = {
      bundleId: 'com.example.app',
      profiles: [],
      warnings: [{ code: 'NO_PROFILE', message: 'No installed profile matched' }],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.discoverSigning('com.example.app')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/api/signing/discover', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ bundleId: 'com.example.app' }),
    }))
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer signing-admin')
  })

  it('opens the API-host profile chooser with an encoded expected bundle ID', async () => {
    setToken('signing-chooser-admin')
    const payload = {
      bundleId: 'com.example.app.extension',
      importedProfileUuid: 'imported-profile-uuid',
      profiles: [],
      warnings: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.chooseSigningProfile('com.example.app+extension')).resolves.toEqual(payload)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/signing/choose?expectedBundleId=com.example.app%2Bextension')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Content-Type')).toBeNull()
    expect(headers.get('Authorization')).toBe('Bearer signing-chooser-admin')
  })

  it('returns null when native profile selection is cancelled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(api.chooseSigningProfile()).resolves.toBeNull()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/signing/choose')
  })

  it('uploads a provisioning profile as raw bytes with an encoded expected bundle ID', async () => {
    setToken('signing-import-admin')
    const file = new File(['profile-bytes'], 'Example.mobileprovision', { type: 'application/octet-stream' })
    const payload = {
      bundleId: 'com.example.app.extension',
      importedProfileUuid: 'imported-profile-uuid',
      profiles: [{
        profileName: 'Example Extension AdHoc',
        uuid: 'imported-profile-uuid',
        teamId: 'AB12CDEFGH',
        teamName: 'Example Team',
        expiresAt: '2027-08-17T00:00:00.000Z',
        certificateCandidates: [],
        recommendedCertificate: null,
        warnings: [],
      }],
      warnings: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.importSigningProfile(file, 'com.example.app+extension')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/signing/import?expectedBundleId=com.example.app%2Bextension')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBe(file)
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('Authorization')).toBe('Bearer signing-import-admin')
  })

  it('omits the expected bundle ID query when importing into an empty row', async () => {
    const payload = {
      bundleId: 'com.example.app',
      importedProfileUuid: 'imported-profile-uuid',
      profiles: [{
        profileName: 'Example App AdHoc',
        uuid: 'imported-profile-uuid',
        teamId: 'AB12CDEFGH',
        teamName: null,
        expiresAt: '2027-08-17T00:00:00.000Z',
        certificateCandidates: [],
        recommendedCertificate: null,
        warnings: [],
      }],
      warnings: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    await api.importSigningProfile(new File(['profile'], 'Example.mobileprovision'))

    expect(fetchMock.mock.calls[0][0]).toBe('/api/signing/import')
  })

  it('posts Setup & Validate for an encoded saved project key', async () => {
    setToken('setup-admin')
    const payload = {
      setup: { dependenciesInstalled: true },
      validation: { valid: true, message: 'Project configuration is valid', canonicalRepoPath: '/repos/setup' },
      project: {
        projectKey: 'setup app', displayName: 'Setup App', repoPath: '/repos/setup', fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:setup', firebaseTesterGroups: ['qa'], firebaseCliTokenEnvVar: 'TOKEN',
        enabled: false, version: 1, validationStatus: 'valid',
      },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    await expect(api.setupAndValidateProject('setup app')).resolves.toMatchObject({
      dependenciesInstalled: true,
      validation: { valid: true },
      project: { projectKey: 'setup app', validationStatus: 'valid' },
    })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/setup%20app/setup-and-validate')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
  })

  it('requests and verifies a member OTP without requiring an admin bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ challengeId: 'challenge-1', expiresInSeconds: 600, message: 'Sent' }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, user: { email: 'member@matechmobile.com', role: 'member' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(api.requestOtp('member@matechmobile.com')).resolves.toMatchObject({ challengeId: 'challenge-1' })
    await expect(api.verifyOtp('challenge-1', '012345')).resolves.toMatchObject({ user: { role: 'member' } })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/otp/request')
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ email: 'member@matechmobile.com' }))
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe('same-origin')
  })

  it('clears the stored token after a 401 response', async () => {
    setToken('expired-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.getSession()).rejects.toBeInstanceOf(ApiError)
    expect(getToken()).toBeNull()
  })
})
