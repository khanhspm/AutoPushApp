import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Project, ProjectInput, RepositoryCandidate, SigningDiscoveryResult, SigningProfileCandidate, SigningProfileImportResult } from '../types'
import { ProjectFormPage } from './ProjectFormPage'

vi.mock('../api/client', () => ({
  api: {
    chooseRepository: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    discoverSigning: vi.fn(),
    chooseSigningProfile: vi.fn(),
    importSigningProfile: vi.fn(),
  },
}))

const SHA1_A = 'A'.repeat(40)
const SHA1_B = 'B'.repeat(40)

const IOS_APP_REPOSITORY: RepositoryCandidate = {
  path: '/Users/runner/repos/ios-app',
  name: 'ios-app',
  rootPath: '/Users/runner/repos',
  relativePath: 'ios-app',
  displayLabel: 'ios-app — /Users/runner/repos/ios-app',
  hasGit: true,
}
const REPLACEMENT_REPOSITORY: RepositoryCandidate = {
  path: '/Users/runner/repos/ios-app-next',
  name: 'ios-app-next',
  rootPath: '/Users/runner/repos',
  relativePath: 'ios-app-next',
  displayLabel: 'ios-app-next — /Users/runner/repos/ios-app-next',
  hasGit: true,
}

function savedProject(overrides: Partial<Project> = {}): Project {
  return {
    projectKey: 'ios-app',
    displayName: 'iOS App',
    repoPath: IOS_APP_REPOSITORY.path,
    fastlaneLane: 'distribute',
    scheme: null,
    buildConfiguration: 'Debug',
    firebaseAppId: '1:123:ios:abc',
    firebaseTesterGroups: ['qa'],
    firebaseCliTokenEnvVar: 'FIREBASE_CLI_TOKEN',
    matchPasswordEnvVar: 'MATCH_PASSWORD',
    appStoreConnectKeyIdEnvVar: null,
    appStoreConnectIssuerIdEnvVar: null,
    appStoreConnectKeyPathEnvVar: null,
    signingMode: 'match',
    appleTeamId: null,
    signingCertificate: 'Apple Distribution',
    provisioningProfiles: [],
    larkNotificationChatId: null,
    enabled: false,
    version: 4,
    validationStatus: 'valid',
    ...overrides,
  }
}

function profile(overrides: Partial<SigningProfileCandidate> = {}): SigningProfileCandidate {
  return {
    profileName: 'Example App AdHoc',
    uuid: '11111111-1111-4111-8111-111111111111',
    teamId: 'AB12CDEFGH',
    teamName: 'Example Team',
    expiresAt: '2027-08-17T00:00:00.000Z',
    certificateCandidates: [{
      name: 'Apple Distribution: Example Team',
      sha1Fingerprint: SHA1_A,
      kind: 'distribution',
    }],
    recommendedCertificate: {
      name: 'Apple Distribution: Example Team',
      sha1Fingerprint: SHA1_A,
      kind: 'distribution',
    },
    warnings: [],
    ...overrides,
  }
}

function discovery(bundleId: string, profiles: SigningProfileCandidate[]): SigningDiscoveryResult {
  return { bundleId, profiles, warnings: [] }
}

function importedProfile(
  bundleId: string,
  profiles: SigningProfileCandidate[],
  importedProfileUuid = profiles[0]?.uuid ?? 'missing-profile',
): SigningProfileImportResult {
  return { ...discovery(bundleId, profiles), importedProfileUuid }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderPage(initialEntry = '/projects/new') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/projects/new" element={<ProjectFormPage />} />
          <Route path="/projects/:projectKey/edit" element={<ProjectFormPage />} />
          <Route path="/projects/:projectKey" element={<div>Project detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function useManualSigning(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Signing mode'), 'manual')
  return {
    team: screen.getByRole('textbox', { name: 'Apple Team ID' }),
    certificate: screen.getByRole('textbox', { name: 'Signing certificate' }),
    bundleId: screen.getByRole('textbox', { name: 'Bundle ID' }),
    profileName: screen.getByRole('textbox', { name: 'Profile name' }),
  }
}

async function replaceText(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, value: string) {
  await user.clear(element)
  await user.type(element, value)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.chooseRepository).mockResolvedValue(IOS_APP_REPOSITORY)
})

afterEach(() => {
  cleanup()
})

describe('ProjectFormPage repository picker', () => {
  it('chooses a folder on create, renders the canonical path read-only, and submits it', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.queryByRole('textbox', { name: /Repository/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument()
    expect(screen.getByText('No repository selected')).toBeInTheDocument()
    expect(screen.getByText(/missing Fastlane files are created automatically/)).toBeInTheDocument()
    expect(screen.getByText((_content, element) => (
      element?.classList.contains('repository-picker-status') === true
      && element.textContent?.includes('Run bundle install separately before validation') === true
    ))).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))

    await waitFor(() => expect(api.chooseRepository).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change folder…' })).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Project key' }), 'ios-app')
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'iOS App')
    await user.type(screen.getByRole('textbox', { name: 'Firebase app ID' }), '1:123:ios:abc')
    await user.type(screen.getByRole('textbox', { name: 'Firebase tester groups' }), 'qa')

    vi.mocked(api.createProject).mockResolvedValue(savedProject())
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: IOS_APP_REPOSITORY.path,
    })))
  })

  it('keeps the current path when the native folder chooser is cancelled', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProject).mockResolvedValue(savedProject())
    vi.mocked(api.chooseRepository).mockResolvedValue(null)
    renderPage('/projects/ios-app/edit')

    expect(await screen.findByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change folder…' }))

    await waitFor(() => expect(api.chooseRepository).toHaveBeenCalledTimes(1))
    expect(screen.getByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()
  })

  it('shows chooser errors without replacing the current path and allows retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProject).mockResolvedValue(savedProject())
    vi.mocked(api.chooseRepository)
      .mockRejectedValueOnce(new Error('Folder must be under IOS_REPO_ROOTS'))
      .mockResolvedValueOnce(REPLACEMENT_REPOSITORY)
    renderPage('/projects/ios-app/edit')

    expect(await screen.findByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change folder…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Folder must be under IOS_REPO_ROOTS')
    expect(screen.getByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change folder…' }))
    expect(await screen.findByText(REPLACEMENT_REPOSITORY.path)).toBeInTheDocument()
  })

  it('changes a saved folder and submits the replacement path', async () => {
    const user = userEvent.setup()
    const project = savedProject()
    vi.mocked(api.getProject).mockResolvedValue(project)
    vi.mocked(api.chooseRepository).mockResolvedValue(REPLACEMENT_REPOSITORY)
    vi.mocked(api.updateProject).mockResolvedValue({ ...project, repoPath: REPLACEMENT_REPOSITORY.path })
    renderPage('/projects/ios-app/edit')

    expect(await screen.findByText(IOS_APP_REPOSITORY.path)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change folder…' }))
    expect(await screen.findByText(REPLACEMENT_REPOSITORY.path)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('ios-app', expect.objectContaining({
      repoPath: REPLACEMENT_REPOSITORY.path,
      version: 4,
    })))
  })
})

describe('ProjectFormPage provisioning profile import', () => {
  it('opens the API-host chooser and derives an empty bundle ID from the imported profile', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(importedProfile('com.example.app', [profile()]))
    renderPage()
    const fields = await useManualSigning(user)

    expect(document.querySelector('input[type="file"]')).not.toBeInTheDocument()
    expect(screen.getByText(/native file dialog opens on the Mac running the API/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    await waitFor(() => expect(api.chooseSigningProfile).toHaveBeenCalledWith(undefined))
    expect(fields.bundleId).toHaveValue('com.example.app')
    expect(fields.profileName).toHaveValue('Example App AdHoc')
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
  })

  it('passes a prefilled bundle ID as the expected ID', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(importedProfile('com.example.app', [profile()]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    await waitFor(() => expect(api.chooseSigningProfile).toHaveBeenCalledWith('com.example.app'))
    expect(fields.bundleId).toHaveValue('com.example.app')
  })

  it('applies the exact importedProfileUuid when the response contains multiple profiles', async () => {
    const user = userEvent.setup()
    const exactImported = profile({
      profileName: 'Exact Imported Profile',
      uuid: 'exact-imported-uuid',
      teamId: 'EXACTTEAM1',
      certificateCandidates: [{ name: 'Apple Distribution: Exact Team', sha1Fingerprint: SHA1_B, kind: 'distribution' }],
      recommendedCertificate: { name: 'Apple Distribution: Exact Team', sha1Fingerprint: SHA1_B, kind: 'distribution' },
    })
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(importedProfile(
      'com.example.app',
      [profile({ profileName: 'Older Installed Profile', uuid: 'older-profile-uuid' }), exactImported],
      exactImported.uuid,
    ))
    renderPage()
    const fields = await useManualSigning(user)

    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    expect(await screen.findByText('Exact Imported Profile')).toBeInTheDocument()
    expect(fields.bundleId).toHaveValue('com.example.app')
    expect(fields.profileName).toHaveValue('Exact Imported Profile')
    expect(fields.team).toHaveValue('EXACTTEAM1')
    expect(fields.certificate).toHaveValue(SHA1_B)
  })

  it('keeps manual values unchanged when native selection is cancelled', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(null)
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.team, 'MANUAL1234')
    await replaceText(user, fields.certificate, 'Manual Certificate')
    await user.type(fields.bundleId, 'com.example.app')
    await user.type(fields.profileName, 'Manual Profile')
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    await waitFor(() => expect(api.chooseSigningProfile).toHaveBeenCalledWith('com.example.app'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(fields.bundleId).toHaveValue('com.example.app')
    expect(fields.profileName).toHaveValue('Manual Profile')
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
  })

  it('reports import errors without changing manual values', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockRejectedValue(new Error('Profile bundle ID does not match'))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.team, 'MANUAL1234')
    await replaceText(user, fields.certificate, 'Manual Certificate')
    await user.type(fields.bundleId, 'com.example.app')
    await user.type(fields.profileName, 'Manual Profile')
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not import provisioning profile.')
    expect(screen.getByRole('alert')).toHaveTextContent('Profile bundle ID does not match')
    expect(fields.bundleId).toHaveValue('com.example.app')
    expect(fields.profileName).toHaveValue('Manual Profile')
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
  })

  it('locks signing controls while import is pending so the completed install stays visible', async () => {
    const user = userEvent.setup()
    const pendingImport = deferred<SigningProfileImportResult | null>()
    vi.mocked(api.chooseSigningProfile).mockReturnValue(pendingImport.promise)
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.original')
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))

    expect(fields.bundleId).toBeDisabled()
    expect(fields.profileName).toBeDisabled()
    expect(fields.team).toBeDisabled()
    expect(fields.certificate).toBeDisabled()
    expect(screen.getByLabelText('Signing mode')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove provisioning profile mapping 1' })).toBeDisabled()

    await act(async () => {
      pendingImport.resolve(importedProfile('com.example.original', [profile()]))
      await pendingImport.promise
    })

    expect(fields.bundleId).toHaveValue('com.example.original')
    expect(fields.profileName).toHaveValue('Example App AdHoc')
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
  })

  it('submits imported values without UUID, row, or discovery metadata', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(importedProfile('com.example.app', [profile()]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(screen.getByRole('textbox', { name: 'Project key' }), 'ios-app')
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'iOS App')
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText(IOS_APP_REPOSITORY.path)
    await user.type(screen.getByRole('textbox', { name: 'Firebase app ID' }), '1:123:ios:abc')
    await user.type(screen.getByRole('textbox', { name: 'Firebase tester groups' }), 'qa')
    await user.click(screen.getByRole('button', { name: 'Choose .mobileprovision…' }))
    await waitFor(() => expect(fields.profileName).toHaveValue('Example App AdHoc'))

    vi.mocked(api.createProject).mockResolvedValue(savedProject({
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: SHA1_A,
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: '11111111-1111-4111-8111-111111111111' }],
    }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1))
    const submitted = vi.mocked(api.createProject).mock.calls[0][0]
    expect(submitted).toMatchObject({
      repoPath: IOS_APP_REPOSITORY.path,
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: SHA1_A,
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: '11111111-1111-4111-8111-111111111111' }],
    })
    expect(submitted.provisioningProfiles[0]).toEqual({ bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: '11111111-1111-4111-8111-111111111111' })
    expect(JSON.stringify(submitted)).not.toMatch(/rowId|discovery|importedProfileUuid|mobileprovision/)
  })
})

describe('ProjectFormPage signing auto-detection', () => {
  it('auto-fills the exact profile, team, and full recommended SHA-1', async () => {
    const user = userEvent.setup()
    vi.mocked(api.discoverSigning).mockResolvedValue(discovery('com.example.app', [profile()]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))

    expect(await screen.findByText('Detected Example App AdHoc')).toBeInTheDocument()
    expect(fields.profileName).toHaveValue('Example App AdHoc')
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
    expect(api.discoverSigning).toHaveBeenCalledWith('com.example.app')
  })

  it('preserves manual values for multiple matches until a profile is explicitly applied', async () => {
    const user = userEvent.setup()
    const secondProfile = profile({
      profileName: 'Example App AdHoc New',
      uuid: 'profile-b',
      teamId: 'TEAMTWO456',
      teamName: 'Second Team',
      certificateCandidates: [{ name: 'Apple Distribution: Second Team', sha1Fingerprint: SHA1_B, kind: 'distribution' }],
      recommendedCertificate: { name: 'Apple Distribution: Second Team', sha1Fingerprint: SHA1_B, kind: 'distribution' },
    })
    vi.mocked(api.discoverSigning).mockResolvedValue(discovery('com.example.app', [
      profile({ teamId: 'TEAMONE123' }),
      secondProfile,
    ]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.team, 'MANUAL1234')
    await replaceText(user, fields.certificate, 'Manual Certificate')
    await user.type(fields.bundleId, 'com.example.app')
    await user.type(fields.profileName, 'Manual Profile')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))

    const selector = await screen.findByRole('combobox', { name: 'Matching profile for com.example.app' })
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
    expect(fields.profileName).toHaveValue('Manual Profile')

    await user.selectOptions(selector, 'profile-b')
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
    expect(fields.profileName).toHaveValue('Manual Profile')

    await user.click(screen.getByRole('button', { name: 'Use selected profile' }))
    expect(fields.team).toHaveValue('TEAMTWO456')
    expect(fields.certificate).toHaveValue(SHA1_B)
    expect(fields.profileName).toHaveValue('Example App AdHoc New')
  })

  it('preserves manual values when no profile matches or discovery fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.discoverSigning)
      .mockResolvedValueOnce(discovery('com.example.app', []))
      .mockRejectedValueOnce(new Error('Runner keychain unavailable'))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.team, 'MANUAL1234')
    await replaceText(user, fields.certificate, 'Manual Certificate')
    await user.type(fields.bundleId, 'com.example.app')
    await user.type(fields.profileName, 'Manual Profile')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))

    expect(await screen.findByText('No valid installed Ad Hoc profile found.')).toBeInTheDocument()
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
    expect(fields.profileName).toHaveValue('Manual Profile')

    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    expect(await screen.findByText('Runner keychain unavailable')).toBeInTheDocument()
    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
    expect(fields.profileName).toHaveValue('Manual Profile')
  })

  it('rejects an invalid bundle ID without calling discovery', async () => {
    const user = userEvent.setup()
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.*')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))

    expect(await screen.findByText('Use a concrete bundle ID without wildcards')).toBeInTheDocument()
    expect(api.discoverSigning).not.toHaveBeenCalled()
  })

  it('preserves the current certificate until one of multiple distribution identities is chosen', async () => {
    const user = userEvent.setup()
    vi.mocked(api.discoverSigning).mockResolvedValue(discovery('com.example.app', [profile({
      certificateCandidates: [
        { name: 'Apple Distribution: First', sha1Fingerprint: SHA1_A, kind: 'distribution' },
        { name: 'Apple Distribution: Second', sha1Fingerprint: SHA1_B, kind: 'distribution' },
      ],
      recommendedCertificate: null,
    })]))
    renderPage()
    const fields = await useManualSigning(user)

    await replaceText(user, fields.certificate, 'Manual Certificate')
    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))

    const certificateSelector = await screen.findByRole('combobox', { name: 'Distribution certificate for com.example.app' })
    expect(fields.certificate).toHaveValue('Manual Certificate')
    await user.selectOptions(certificateSelector, SHA1_B)
    expect(fields.certificate).toHaveValue('Manual Certificate')
    await user.click(screen.getByRole('button', { name: 'Use certificate' }))
    expect(fields.certificate).toHaveValue(SHA1_B)
  })

  it('ignores stale discovery after the bundle ID changes or its row is removed', async () => {
    const user = userEvent.setup()
    const first = deferred<SigningDiscoveryResult>()
    const second = deferred<SigningDiscoveryResult>()
    vi.mocked(api.discoverSigning)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    await replaceText(user, fields.bundleId, 'com.example.changed')
    await act(async () => {
      first.resolve(discovery('com.example.app', [profile()]))
      await first.promise
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto detect' })).toBeEnabled())
    expect(screen.queryByText('Detected Example App AdHoc')).not.toBeInTheDocument()
    expect(fields.profileName).toHaveValue('')
    expect(fields.team).toHaveValue('')
    expect(fields.certificate).toHaveValue('Apple Distribution')

    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    await user.click(screen.getByRole('button', { name: 'Remove provisioning profile mapping 1' }))
    await act(async () => {
      second.resolve(discovery('com.example.changed', [profile()]))
      await second.promise
    })

    expect(screen.queryByRole('textbox', { name: 'Bundle ID' })).not.toBeInTheDocument()
    expect(screen.queryByText('Detected Example App AdHoc')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Apple Team ID' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Signing certificate' })).toHaveValue('Apple Distribution')
  })

  it('does not overwrite newer manual team or certificate edits with a late discovery result', async () => {
    const user = userEvent.setup()
    const pending = deferred<SigningDiscoveryResult>()
    vi.mocked(api.discoverSigning).mockReturnValue(pending.promise)
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    await user.type(fields.team, 'MANUAL1234')
    await replaceText(user, fields.certificate, 'Manual Certificate')
    await act(async () => {
      pending.resolve(discovery('com.example.app', [profile()]))
      await pending.promise
    })

    expect(fields.team).toHaveValue('MANUAL1234')
    expect(fields.certificate).toHaveValue('Manual Certificate')
    expect(fields.profileName).toHaveValue('')
    expect(screen.queryByText('Detected Example App AdHoc')).not.toBeInTheDocument()
  })

  it('blocks profiles from different teams from replacing project-global signing values', async () => {
    const user = userEvent.setup()
    vi.mocked(api.discoverSigning)
      .mockResolvedValueOnce(discovery('com.example.app', [profile()]))
      .mockResolvedValueOnce(discovery('com.example.extension', [profile({
        profileName: 'Extension AdHoc',
        uuid: 'extension-profile',
        teamId: 'DIFFTEAM12',
        certificateCandidates: [{ name: 'Apple Distribution: Other Team', sha1Fingerprint: SHA1_B, kind: 'distribution' }],
        recommendedCertificate: { name: 'Apple Distribution: Other Team', sha1Fingerprint: SHA1_B, kind: 'distribution' },
      })]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    await screen.findByText('Detected Example App AdHoc')
    await user.click(screen.getByRole('button', { name: 'Add mapping' }))

    const bundleInputs = screen.getAllByRole('textbox', { name: 'Bundle ID' })
    const detectButtons = screen.getAllByRole('button', { name: 'Auto detect' })
    await user.type(bundleInputs[1], 'com.example.extension')
    await user.click(detectButtons[1])

    expect(await screen.findByText('All provisioning profiles must use the same Apple Team ID')).toBeInTheDocument()
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
    expect(screen.getAllByRole('textbox', { name: 'Profile name' })[1]).toHaveValue('')
  })

  it('submits manual overrides without row or discovery metadata', async () => {
    const user = userEvent.setup()
    vi.mocked(api.discoverSigning).mockResolvedValue(discovery('com.example.app', [profile()]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(screen.getByRole('textbox', { name: 'Project key' }), 'ios-app')
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'iOS App')
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText(IOS_APP_REPOSITORY.path)
    await user.type(screen.getByRole('textbox', { name: 'Firebase app ID' }), '1:123:ios:abc')
    await user.type(screen.getByRole('textbox', { name: 'Firebase tester groups' }), 'qa, internal, qa')
    await user.type(fields.bundleId, 'com.example.app')
    await user.click(screen.getByRole('button', { name: 'Auto detect' }))
    await screen.findByText('Detected Example App AdHoc')

    await replaceText(user, fields.team, 'OVERRIDE12')
    await replaceText(user, fields.certificate, SHA1_B)
    await replaceText(user, fields.profileName, 'Manual Override Profile')

    const expected: ProjectInput = {
      projectKey: 'ios-app',
      displayName: 'iOS App',
      repoPath: IOS_APP_REPOSITORY.path,
      fastlaneLane: 'distribute',
      scheme: undefined,
      buildConfiguration: 'Debug',
      firebaseAppId: '1:123:ios:abc',
      firebaseTesterGroups: ['qa', 'internal'],
      firebaseCliTokenEnvVar: 'FIREBASE_CLI_TOKEN',
      matchPasswordEnvVar: 'MATCH_PASSWORD',
      appStoreConnectKeyIdEnvVar: undefined,
      appStoreConnectIssuerIdEnvVar: undefined,
      appStoreConnectKeyPathEnvVar: undefined,
      signingMode: 'manual',
      appleTeamId: 'OVERRIDE12',
      signingCertificate: SHA1_B,
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Manual Override Profile' }],
      larkNotificationChatId: undefined,
      enabled: false,
    }
    vi.mocked(api.createProject).mockResolvedValue({
      ...expected,
      version: 1,
      validationStatus: 'valid',
    })

    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith(expected))
    const submitted = vi.mocked(api.createProject).mock.calls[0][0]
    expect(submitted.provisioningProfiles[0]).not.toHaveProperty('rowId')
    expect(submitted).not.toHaveProperty('discoveryByRow')
    expect(JSON.stringify(submitted)).not.toContain('11111111-1111-4111-8111-111111111111')
  })
})
