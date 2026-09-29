import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type {
  Project,
  ProjectInput,
  RepositoryCandidate,
  SigningDiscoveryResult,
  SigningInventory,
  SigningInventoryProfile,
  SigningProfileCandidate,
  SigningProfileImportResult,
} from '../types'
import { ProjectFormPage } from './ProjectFormPage'

vi.mock('../api/client', () => ({
  api: {
    chooseRepository: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    discoverSigning: vi.fn(),
    getSigningInventory: vi.fn(),
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

const CERT_A = { name: 'Apple Distribution: Example Team', sha1Fingerprint: SHA1_A, kind: 'distribution' as const }
const CERT_B = { name: 'Apple Distribution: Second Identity', sha1Fingerprint: SHA1_B, kind: 'distribution' as const }

function inventoryProfile(overrides: Partial<SigningInventoryProfile> = {}): SigningInventoryProfile {
  return { ...profile(), bundleId: 'com.example.app', ...overrides }
}

const APP_PROFILE = inventoryProfile()
const WIDGET_PROFILE = inventoryProfile({
  bundleId: 'com.example.widget',
  profileName: 'Widget AdHoc',
  uuid: '22222222-2222-4222-8222-222222222222',
})

function inventory(profiles: SigningInventoryProfile[] = [APP_PROFILE, WIDGET_PROFILE]): SigningInventory {
  return { profiles, certificates: [CERT_A, CERT_B], warnings: [] }
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
  await screen.findAllByRole('option', { name: /com\.example\.app/ })
  return {
    team: screen.getByRole('textbox', { name: 'Apple Team ID' }),
    certificate: screen.getByRole('combobox', { name: 'Signing certificate' }),
    profile: (index: number) => screen.getByRole('combobox', { name: `Provisioning profile ${index}` }),
  }
}

async function replaceText(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, value: string) {
  await user.clear(element)
  await user.type(element, value)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.chooseRepository).mockResolvedValue(IOS_APP_REPOSITORY)
  vi.mocked(api.getSigningInventory).mockResolvedValue(inventory())
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


describe('ProjectFormPage manual signing', () => {
  it('lists installed profiles and fills bundle ID, team, and certificate from the chosen profile', async () => {
    const user = userEvent.setup()
    renderPage()
    const fields = await useManualSigning(user)

    expect(api.getSigningInventory).toHaveBeenCalled()
    expect(fields.profile(1)).toHaveTextContent('com.example.app — Example App AdHoc (AB12CDEFGH')
    expect(fields.profile(1)).toHaveTextContent('com.example.widget — Widget AdHoc')
    expect(fields.certificate).toHaveTextContent('Apple Distribution: Example Team')
    expect(fields.certificate).toHaveTextContent('Apple Distribution: Second Identity')

    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)

    expect(screen.getByText('com.example.app', { selector: 'code' })).toBeInTheDocument()
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
  })

  it('lets the user pick another installed certificate', async () => {
    const user = userEvent.setup()
    renderPage()
    const fields = await useManualSigning(user)

    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)
    await user.selectOptions(fields.certificate, SHA1_B)

    expect(fields.certificate).toHaveValue(SHA1_B)
    expect(screen.getByText('Example App AdHoc does not include this certificate')).toBeInTheDocument()
  })

  it('rejects a second profile from a different team', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getSigningInventory).mockResolvedValue(inventory([
      APP_PROFILE,
      inventoryProfile({ bundleId: 'com.other.app', profileName: 'Other AdHoc', uuid: 'other-uuid', teamId: 'DIFFTEAM12' }),
    ]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)
    await user.click(screen.getByRole('button', { name: 'Add profile' }))
    await user.selectOptions(fields.profile(2), 'other-uuid')

    expect(await screen.findByText('All provisioning profiles must use the same Apple Team ID (AB12CDEFGH)')).toBeInTheDocument()
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.profile(2)).toHaveValue('')
  })

  it('rejects mapping the same bundle ID twice', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getSigningInventory).mockResolvedValue(inventory([
      APP_PROFILE,
      inventoryProfile({ profileName: 'Example App AdHoc 2', uuid: 'second-app-uuid' }),
    ]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)
    await user.click(screen.getByRole('button', { name: 'Add profile' }))
    await user.selectOptions(fields.profile(2), 'second-app-uuid')

    expect(await screen.findByText('com.example.app is already mapped')).toBeInTheDocument()
    expect(fields.profile(2)).toHaveValue('')
  })

  it('imports a .mobileprovision file, refreshes the list, and selects the imported profile', async () => {
    const user = userEvent.setup()
    const imported = inventoryProfile({ bundleId: 'com.example.new', profileName: 'New AdHoc', uuid: 'new-uuid' })
    vi.mocked(api.getSigningInventory)
      .mockResolvedValueOnce(inventory([APP_PROFILE]))
      .mockResolvedValue(inventory([APP_PROFILE, imported]))
    vi.mocked(api.chooseSigningProfile).mockResolvedValue(importedProfile('com.example.new', [imported]))
    renderPage()
    const fields = await useManualSigning(user)

    await user.click(screen.getByRole('button', { name: 'Import .mobileprovision…' }))

    await waitFor(() => expect(fields.profile(1)).toHaveValue('new-uuid'))
    expect(api.chooseSigningProfile).toHaveBeenCalledWith()
    expect(screen.getByRole('status')).toHaveTextContent('Installed New AdHoc for com.example.new.')
    expect(fields.team).toHaveValue('AB12CDEFGH')
    expect(fields.certificate).toHaveValue(SHA1_A)
  })

  it('reports import errors without changing the selection', async () => {
    const user = userEvent.setup()
    vi.mocked(api.chooseSigningProfile).mockRejectedValue(new Error('Profile is not Ad Hoc'))
    renderPage()
    const fields = await useManualSigning(user)

    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)
    await user.click(screen.getByRole('button', { name: 'Import .mobileprovision…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Profile is not Ad Hoc')
    expect(fields.profile(1)).toHaveValue(APP_PROFILE.uuid)
  })

  it('locks signing controls while an import is pending', async () => {
    const user = userEvent.setup()
    const pending = deferred<SigningProfileImportResult>()
    vi.mocked(api.chooseSigningProfile).mockReturnValue(pending.promise)
    renderPage()
    const fields = await useManualSigning(user)

    await user.click(screen.getByRole('button', { name: 'Import .mobileprovision…' }))

    expect(await screen.findByRole('button', { name: 'Importing…' })).toBeDisabled()
    expect(fields.profile(1)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeDisabled()

    pending.reject(new Error('cancelled'))
    await waitFor(() => expect(fields.profile(1)).toBeEnabled())
  })

  it('shows an error when installed signing assets cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getSigningInventory).mockRejectedValue(new Error('Runner keychain unavailable'))
    renderPage()
    await user.selectOptions(screen.getByLabelText('Signing mode'), 'manual')

    expect(await screen.findByRole('alert')).toHaveTextContent('Runner keychain unavailable')
  })

  it('keeps saved mappings that are no longer installed', async () => {
    vi.mocked(api.getProject).mockResolvedValue(savedProject({
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.legacy.app', profileName: 'Legacy AdHoc' }],
    }))
    renderPage('/projects/ios-app/edit')

    const select = await screen.findByRole('combobox', { name: 'Provisioning profile 1' })
    expect(select).toHaveDisplayValue('com.legacy.app — Legacy AdHoc (current, not in installed list)')
    expect(screen.getByRole('combobox', { name: 'Signing certificate' })).toHaveDisplayValue('Apple Distribution (current)')
  })

  it('submits the selected profiles and certificate without form metadata', async () => {
    const user = userEvent.setup()
    renderPage()
    const fields = await useManualSigning(user)

    await user.type(screen.getByRole('textbox', { name: 'Project key' }), 'ios-app')
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'iOS App')
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText(IOS_APP_REPOSITORY.path)
    await user.type(screen.getByRole('textbox', { name: 'Firebase app ID' }), '1:123:ios:abc')
    await user.type(screen.getByRole('textbox', { name: 'Firebase tester groups' }), 'qa, internal, qa')
    await user.selectOptions(fields.profile(1), APP_PROFILE.uuid)
    await user.click(screen.getByRole('button', { name: 'Add profile' }))
    await user.selectOptions(fields.profile(2), WIDGET_PROFILE.uuid)

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
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: SHA1_A,
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: 'Example App AdHoc', profileUuid: APP_PROFILE.uuid },
        { bundleId: 'com.example.widget', profileName: 'Widget AdHoc', profileUuid: WIDGET_PROFILE.uuid },
      ],
      larkNotificationChatId: undefined,
      enabled: false,
    }
    vi.mocked(api.createProject).mockResolvedValue({ ...expected, version: 1, validationStatus: 'valid' })

    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith(expected))
    expect(JSON.stringify(vi.mocked(api.createProject).mock.calls[0][0])).not.toMatch(/rowId|importedProfileUuid/)
  })
})
