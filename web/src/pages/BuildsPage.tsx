import { FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '../components/ui'
import { formatBuildVersion, formatDuration, formatRelativeTime, titleCase } from '../lib/format'

export function BuildsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const projectKey = searchParams.get('projectKey') ?? ''
  const status = searchParams.get('status') ?? ''
  const source = searchParams.get('source') ?? ''
  const cursor = searchParams.get('cursor') ?? ''
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.getProjects })
  const builds = useQuery({ queryKey: ['builds', { projectKey, status, source, cursor }], queryFn: () => api.getBuilds({ projectKey, status, source, cursor, limit: 25 }) })

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const next = new URLSearchParams()
    for (const key of ['projectKey', 'status', 'source']) { const value = String(data.get(key) ?? ''); if (value) next.set(key, value) }
    setSearchParams(next)
  }
  function openNext() { if (!builds.data?.nextCursor) return; const next = new URLSearchParams(searchParams); next.set('cursor', builds.data.nextCursor); setSearchParams(next) }

  return <div className="page-stack">
    <PageHeader eyebrow="Delivery audit" title="Build history" description="Filter build runs, inspect output, and safely retry failures." actions={<Link className="button button-primary" to="/builds/new">New build</Link>} />
    <form className="filter-bar" onSubmit={applyFilters} key={`${projectKey}:${status}:${source}`}>
      <label><span>Project</span><select className="input select" name="projectKey" defaultValue={projectKey}><option value="">All projects</option>{projects.data?.map((project) => <option key={project.projectKey} value={project.projectKey}>{project.displayName}</option>)}</select></label>
      <label><span>Status</span><select className="input select" name="status" defaultValue={status}><option value="">All statuses</option><option value="enqueueing">Enqueueing</option><option value="queued">Queued</option><option value="running">Running</option><option value="success">Succeeded</option><option value="failed">Failed</option></select></label>
      <label><span>Source</span><select className="input select" name="source" defaultValue={source}><option value="">All sources</option><option value="cms">CMS</option><option value="lark">Lark</option></select></label>
      <div className="filter-actions"><button className="button button-secondary">Apply</button>{searchParams.toString() && <button className="button button-ghost" type="button" onClick={() => setSearchParams({})}>Clear</button>}</div>
    </form>
    {builds.isLoading && <LoadingState label="Loading builds" />}
    {builds.isError && <ErrorState error={builds.error} onRetry={() => builds.refetch()} />}
    {builds.data && builds.data.items.length === 0 && <EmptyState title="No matching builds" description="Change the filters or trigger a new build from a project." />}
    {builds.data && builds.data.items.length > 0 && <section className="panel build-table-panel">
      <div className="table-summary">Showing <strong>{builds.data.items.length}</strong> builds on this page</div>
      <div className="table-scroll"><table><thead><tr><th>Build</th><th>Project</th><th>Version</th><th>Status</th><th>Source</th><th>Requested by</th><th>Duration</th><th>Created</th><th /></tr></thead><tbody>{builds.data.items.map((build) => <tr key={build.id}>
        <td><Link className="table-link mono" to={`/builds/${build.id}`}>#{build.id.slice(0,8)}</Link>{build.attemptCount && build.attemptCount > 1 ? <small className="attempt-label">Attempt {build.attemptCount}</small> : null}</td>
        <td><strong>{build.projectName ?? build.projectKey}</strong><small className="table-subtext mono">{build.projectKey}</small></td>
        <td className="mono">{formatBuildVersion(build.appVersion, build.buildNumber)}</td><td><StatusBadge status={build.status} /></td><td>{titleCase(build.source)}</td><td>{build.requestedBy || 'System'}</td>
        <td>{formatDuration(build.durationMs)}</td><td title={build.createdAt}>{formatRelativeTime(build.createdAt)}</td><td><Link className="icon-button" aria-label={`Open build ${build.id}`} to={`/builds/${build.id}`}>→</Link></td>
      </tr>)}</tbody></table></div>
      <div className="pagination"><span>{cursor ? 'Older build page' : 'Latest builds'}</span><div>{cursor && <button className="button button-secondary button-small" onClick={() => { const next = new URLSearchParams(searchParams); next.delete('cursor'); setSearchParams(next) }}>Back to latest</button>}<button className="button button-secondary button-small" disabled={!builds.data.nextCursor} onClick={openNext}>Older builds</button></div></div>
    </section>}
  </div>
}
