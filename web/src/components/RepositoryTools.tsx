import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export function ProjectTerminal({ repoPath }: { repoPath: string }) {
  const [commands, setCommands] = useState('')
  const run = useMutation({ mutationFn: () => api.runTerminal(repoPath, commands) })
  return <section className="panel compact-panel page-stack-small">
    <h2>Terminal / setup</h2>
    <p className="form-note">Runs on the build Mac in <code>{repoPath ? `cwd: ${repoPath}` : 'the selected folder'}</code>. Commands run in order and stop on failure. Limit: 15 minutes.</p>
    <label className="field"><span className="field-label">Terminal commands</span><textarea className="input textarea mono" rows={5} value={commands} onChange={(event) => setCommands(event.target.value)} placeholder={'bundle install\nbundle exec pod install'} /></label>
    <button type="button" className="button button-secondary" disabled={!repoPath || !commands.trim() || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Running commands…' : 'Run commands'}</button>
    {run.isError && <p role="alert" className="field-error">{run.error.message}</p>}
    {run.data && <><p role="status">Exit code: {run.data.exitCode}{run.data.timedOut ? ' · Timed out' : ''}{run.data.truncated ? ' · Showing last output only' : ''}</p><pre className="terminal-output">{run.data.output || '(No output)'}</pre></>}
  </section>
}

export function RepositoryGit({ projectKey }: { projectKey: string }) {
  const [branch, setBranch] = useState('')
  const state = useQuery({ queryKey: ['git', projectKey], queryFn: () => api.getGit(projectKey), refetchInterval: 15_000 })
  const operation = useMutation({
    mutationFn: (action: 'fetch' | 'checkout') => api.gitOperation(projectKey, action, branch),
    onSuccess: () => { void state.refetch() },
  })
  return <section className="panel compact-panel page-stack-small">
    <h2>Git repository</h2>
    {state.isLoading && <p>Loading Git…</p>}
    {state.isError && <p role="alert" className="field-error">{state.error.message}</p>}
    {state.data && <>
      <p>Current branch: <strong>{state.data.branch === 'HEAD' ? 'Detached HEAD' : state.data.branch}</strong> · <code>{state.data.head.slice(0, 12)}</code>{state.data.dirty ? ' · Uncommitted changes' : ''}</p>
      <label className="field"><span className="field-label">Checkout branch</span><select className="input" value={branch} onChange={(event) => setBranch(event.target.value)}><option value="">Select a branch</option>{state.data.branches.map((name) => <option key={name}>{name}</option>)}</select></label>
    </>}
    <div className="form-actions"><button type="button" className="button button-secondary" disabled={operation.isPending} onClick={() => operation.mutate('fetch')}>Fetch</button><button type="button" className="button button-secondary" disabled={!branch || operation.isPending} onClick={() => operation.mutate('checkout')}>{operation.isPending ? 'Working…' : 'Checkout'}</button></div>
    {operation.isError && <p role="alert" className="field-error">{operation.error.message}</p>}
    <h3>Latest 30 commits</h3>
    <div className="git-history">{state.data?.commits.map((commit) => <div key={commit.hash}><code title={commit.hash}>{commit.hash.slice(0, 10)}</code> <strong>{commit.subject}</strong><p className="form-note">{commit.author} · {new Date(commit.date).toLocaleString()}</p></div>)}</div>
  </section>
}

export function RepositoryFolders({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const folders = useQuery({ queryKey: ['repository-folders'], queryFn: () => api.getRepositoryFolders() })
  const [root, setRoot] = useState('')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const clone = useMutation({ mutationFn: () => api.cloneRepository(root || folders.data?.roots[0] || '', name, url), onSuccess: (repository) => { onChange(repository.path); void folders.refetch() } })
  return <div className="field field-full page-stack-small">
    <label className="field"><span className="field-label">Folders in IOS_REPO_ROOTS</span><select className="input" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select a folder</option>{value && !folders.data?.folders.some((folder) => folder.path === value) && <option value={value}>Folder: {value}</option>}{folders.data?.folders.map((folder) => <option key={folder.path} value={folder.path}>Folder: {folder.path}</option>)}</select></label>
    {folders.isLoading && <p>Loading folders…</p>}
    {folders.isError && <p role="alert">{folders.error.message}</p>}
    <button type="button" className="button button-ghost" onClick={() => void folders.refetch()}>Refresh folders</button>
    <details><summary>Project not available? Clone with SSH</summary><div className="page-stack-small">
      <label className="field"><span className="field-label">Clone destination root</span><select className="input" value={root || folders.data?.roots[0] || ''} onChange={(event) => setRoot(event.target.value)}>{folders.data?.roots.map((folder) => <option key={folder}>{folder}</option>)}</select></label>
      <label className="field"><span className="field-label">SSH Git URL</span><input className="input" placeholder="git@github.com:team/project.git" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <label className="field"><span className="field-label">New folder name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" className="button button-secondary" disabled={clone.isPending || !url || !name || !folders.data?.roots.length} onClick={() => clone.mutate()}>{clone.isPending ? 'Cloning…' : 'Clone SSH'}</button>
      {clone.isError && <p role="alert" className="field-error">{clone.error.message}</p>}
    </div></details>
    <ProjectTerminal key={value} repoPath={value} />
  </div>
}
