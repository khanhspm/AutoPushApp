import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { ProjectTerminal, RepositoryFolders, RepositoryGit } from './RepositoryTools'
vi.mock('../api/client', () => ({ api: { runTerminal: vi.fn(), getRepositoryFolders: vi.fn(), cloneRepository: vi.fn(), getGit: vi.fn(), gitOperation: vi.fn() } }))
function mount(element: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>)
}
beforeEach(() => vi.resetAllMocks())
it('submits commands with the selected cwd and shows failed command output', async () => {
  vi.mocked(api.runTerminal).mockResolvedValue({ output: 'dependency missing', exitCode: 1, timedOut: false, truncated: false })
  mount(<ProjectTerminal repoPath="/repos/app" />)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Terminal commands'), 'bundle install')
  await user.click(screen.getByRole('button', { name: 'Run commands' }))
  expect(await screen.findByText('dependency missing')).toBeInTheDocument()
  expect(api.runTerminal).toHaveBeenCalledWith('/repos/app', 'bundle install')
  expect(screen.getByRole('status')).toHaveTextContent('Exit code: 1')
})
it('selects a discovered folder and selects the SSH clone result', async () => {
  const onChange = vi.fn()
  vi.mocked(api.getRepositoryFolders).mockResolvedValue({ roots: ['/repos'], folders: [{ path: '/repos/app', name: 'app' }] })
  vi.mocked(api.cloneRepository).mockResolvedValue({ path: '/repos/new-app' } as Awaited<ReturnType<typeof api.cloneRepository>>)
  mount(<RepositoryFolders value="" onChange={onChange} />)
  const user = userEvent.setup()
  await screen.findByRole('option', { name: 'Folder: /repos/app' })
  await user.selectOptions(screen.getByLabelText('Folders in IOS_REPO_ROOTS'), '/repos/app')
  expect(onChange).toHaveBeenCalledWith('/repos/app')
  await user.click(screen.getByText('Project not available? Clone with SSH'))
  await user.type(screen.getByLabelText('SSH Git URL'), 'git@github.com:team/app.git')
  await user.type(screen.getByLabelText('New folder name'), 'new-app')
  await user.click(screen.getByRole('button', { name: 'Clone SSH' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('/repos/new-app'))
  expect(api.cloneRepository).toHaveBeenCalledWith('/repos', 'new-app', 'git@github.com:team/app.git')
})
it('shows the branch and history and submits fetch and checkout', async () => {
  const state = { branch: 'main', head: 'abc123', dirty: false, branches: ['main', 'feature'], commits: [{ hash: 'abc123', author: 'Test', date: '2026-10-14', subject: 'Fix build' }] }
  vi.mocked(api.getGit).mockResolvedValue(state)
  vi.mocked(api.gitOperation).mockResolvedValue(state)
  mount(<RepositoryGit projectKey="app" />)
  const user = userEvent.setup()
  expect(await screen.findByText('Fix build')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Fetch' }))
  await waitFor(() => expect(api.gitOperation).toHaveBeenCalledWith('app', 'fetch', ''))
  await user.selectOptions(screen.getByLabelText('Checkout branch'), 'feature')
  await user.click(screen.getByRole('button', { name: 'Checkout' }))
  await waitFor(() => expect(api.gitOperation).toHaveBeenCalledWith('app', 'checkout', 'feature'))
})

afterEach(cleanup)
