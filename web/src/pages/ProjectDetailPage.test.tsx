import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Project } from '../types'
import { ProjectDetailPage } from './ProjectDetailPage'

vi.mock('../api/client', () => ({
  api: {
    getProject: vi.fn(),
    setupAndValidateProject: vi.fn(),
    triggerBuild: vi.fn(),
    deleteProject: vi.fn(),
  },
}))

const project: Project = {
  projectKey: 'setup-app',
  displayName: 'Setup App',
  repoPath: '/repos/setup-app',
  fastlaneLane: 'distribute',
  scheme: 'SetupApp',
  buildConfiguration: 'Release',
  firebaseAppId: '1:123:ios:setup',
  firebaseTesterGroups: ['qa'],
  firebaseCliTokenEnvVar: 'SETUP_FIREBASE_TOKEN',
  signingMode: 'manual',
  appleTeamId: 'AB12CDEFGH',
  signingCertificate: 'Apple Distribution',
  provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example AdHoc' }],
  enabled: false,
  version: 1,
  validationStatus: 'unknown',
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/setup-app']}>
        <Routes>
          <Route path="/projects/:projectKey" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ProjectDetailPage Setup & Validate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getProject).mockResolvedValue(project)
  })

  it('runs setup, updates validation state, and reports installed dependencies', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setupAndValidateProject).mockResolvedValue({
      dependenciesInstalled: true,
      validation: { valid: true, message: 'Project configuration is valid', canonicalRepoPath: project.repoPath },
      project: { ...project, validationStatus: 'valid', validationMessage: 'Project configuration is valid' },
    })

    renderPage()

    const button = await screen.findByRole('button', { name: 'Setup & Validate' })
    expect(screen.getByText(/Run Setup & Validate, then enable/i)).toBeInTheDocument()
    await user.click(button)

    expect(api.setupAndValidateProject).toHaveBeenCalledWith('setup-app')
    expect(await screen.findByText('Dependencies installed in vendor/bundle.')).toBeInTheDocument()
    expect(screen.getByText('Project configuration is valid')).toBeInTheDocument()
    expect(api.triggerBuild).not.toHaveBeenCalled()
  })

  it('shows setup errors and allows retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setupAndValidateProject)
      .mockRejectedValueOnce(new Error('Bundler could not install the project dependencies'))
      .mockResolvedValueOnce({
        dependenciesInstalled: false,
        validation: { valid: true, message: 'Project configuration is valid' },
        project: { ...project, validationStatus: 'valid' },
      })

    renderPage()
    const button = await screen.findByRole('button', { name: 'Setup & Validate' })
    await user.click(button)
    expect(await screen.findByText('Bundler could not install the project dependencies')).toBeInTheDocument()
    await user.click(button)
    expect(api.setupAndValidateProject).toHaveBeenCalledTimes(2)
  })
})
