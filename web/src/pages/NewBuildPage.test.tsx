import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Build, Project } from '../types'
import { NewBuildPage } from './NewBuildPage'

vi.mock('../api/client', () => ({
  api: {
    getProjects: vi.fn(),
    triggerBuild: vi.fn(),
  },
}))

const projects: Project[] = [
  {
    projectKey: 'consumer-app',
    displayName: 'Consumer App',
    repoPath: '/repos/consumer',
    fastlaneLane: 'distribute',
    scheme: 'Consumer',
    buildConfiguration: 'Release',
    firebaseAppId: '1:123:ios:consumer',
    firebaseTesterGroups: ['qa'],
    firebaseCliTokenEnvVar: 'CONSUMER_FIREBASE_TOKEN',
    enabled: true,
    version: 1,
    validationStatus: 'valid',
  },
  {
    projectKey: 'partner-app',
    displayName: 'Partner App',
    repoPath: '/repos/partner',
    fastlaneLane: 'beta',
    scheme: 'Partner',
    buildConfiguration: 'Release',
    firebaseAppId: '1:123:ios:partner',
    firebaseTesterGroups: ['internal'],
    firebaseCliTokenEnvVar: 'PARTNER_FIREBASE_TOKEN',
    enabled: true,
    version: 1,
    validationStatus: 'valid',
  },
]

function renderPage(initialEntry = '/builds/new') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/builds/new" element={<NewBuildPage />} />
          <Route path="/builds/:id" element={<div>Build detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NewBuildPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getProjects).mockResolvedValue(projects)
  })

  it('preselects a project and queues its build', async () => {
    const user = userEvent.setup()
    const build: Build = {
      id: 'build-123',
      projectKey: 'partner-app',
      appVersion: '1.1',
      buildNumber: '205',
      source: 'cms',
      status: 'queued',
      createdAt: '2026-08-05T00:00:00.000Z',
    }
    vi.mocked(api.triggerBuild).mockResolvedValue(build)

    renderPage('/builds/new?projectKey=partner-app')

    expect(await screen.findByRole('combobox', { name: /iOS project/i })).toHaveValue('partner-app')
    expect(screen.getAllByText('Partner App')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: /^scheme$/i })).toHaveValue('Partner')
    await user.clear(screen.getByRole('textbox', { name: /^scheme$/i }))
    await user.type(screen.getByRole('textbox', { name: /^scheme$/i }), 'PartnerDebug')
    await user.type(screen.getByRole('textbox', { name: /app version/i }), '1.1')
    await user.type(screen.getByRole('textbox', { name: /build number/i }), '205')
    await user.type(screen.getByRole('textbox', { name: /release notes/i }), 'QA candidate')
    await user.click(screen.getByRole('button', { name: 'Queue build' }))

    expect(api.triggerBuild).toHaveBeenCalledWith('partner-app', { appVersion: '1.1', scheme: 'PartnerDebug', buildNumber: '205', releaseNotes: 'QA candidate' })
    expect(await screen.findByText('Build detail')).toBeInTheDocument()
  })

  it('requires an enabled project selection', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('combobox', { name: /iOS project/i })
    await user.type(screen.getByRole('textbox', { name: /build number/i }), '206')
    expect(screen.getByRole('button', { name: 'Queue build' })).toBeDisabled()
    expect(api.triggerBuild).not.toHaveBeenCalled()
  })
})
