import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { formatBuildVersion, formatDuration, formatRelativeTime, titleCase } from '../lib/format'
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '../components/ui'

function MetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  detail: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-label"><span className="metric-mark" />{label}</div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
    </article>
  )
}

export function DashboardPage() {
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.getDashboard,
    refetchInterval: 5_000,
  })

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Operations overview"
        title="Dashboard"
        description="Live health, queue activity, and the latest delivery runs."
        actions={<Link className="button button-primary" to="/builds/new">Trigger a build</Link>}
      />

      {dashboard.isLoading && <LoadingState label="Loading dashboard" />}
      {dashboard.isError && <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />}
      {dashboard.data && (
        <>
          <section className="metric-grid" aria-label="Build metrics">
            <MetricCard label="Projects" value={dashboard.data.projectsTotal} detail={`${dashboard.data.projectsEnabled} enabled`} />
            <MetricCard label="Active builds" value={dashboard.data.buildsActive} detail={`${dashboard.data.buildsQueued} waiting in queue`} tone={dashboard.data.buildsActive ? 'warning' : 'neutral'} />
            <MetricCard label="Succeeded" value={dashboard.data.buildsSucceeded} detail={`${dashboard.data.last24HoursSucceeded} in the last 24 hours`} tone="success" />
            <MetricCard label="Failed" value={dashboard.data.buildsFailed} detail={`${dashboard.data.last24HoursFailed} in the last 24 hours`} tone={dashboard.data.buildsFailed ? 'danger' : 'neutral'} />
          </section>

          <section className="dashboard-grid">
            <article className="panel panel-wide">
              <div className="panel-header">
                <div><p className="panel-kicker">Latest activity</p><h2>Recent builds</h2></div>
                <Link className="text-link" to="/builds">View all builds <span>→</span></Link>
              </div>
              {dashboard.data.recentBuilds.length === 0 ? (
                <EmptyState title="No builds yet" description="Trigger a project build to see live activity here." />
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Build</th><th>Project</th><th>Source</th><th>Status</th><th>Duration</th><th>Created</th></tr></thead>
                    <tbody>
                      {dashboard.data.recentBuilds.slice(0, 8).map((build) => (
                        <tr key={build.id}>
                          <td><Link className="table-link mono" to={`/builds/${build.id}`}>#{build.id.slice(0, 8)}</Link></td>
                          <td><strong>{build.projectName ?? build.projectKey}</strong></td>
                          <td><span className="source-cell"><span>Build {formatBuildVersion(build.appVersion, build.buildNumber)}</span><small>{titleCase(build.source)}</small></span></td>
                          <td><StatusBadge status={build.status} /></td>
                          <td>{formatDuration(build.durationMs)}</td>
                          <td title={build.createdAt}>{formatRelativeTime(build.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>

            <aside className="panel queue-panel">
              <div className="panel-header"><div><p className="panel-kicker">System status</p><h2>Build queue</h2></div></div>
              <div className="queue-visual">
                <div className="queue-ring"><strong>{dashboard.data.buildsActive}</strong><span>active</span></div>
              </div>
              <dl className="queue-stats">
                <div><dt><span className="legend-dot running" />Running</dt><dd>{dashboard.data.buildsActive}</dd></div>
                <div><dt><span className="legend-dot queued" />Queued</dt><dd>{dashboard.data.buildsQueued}</dd></div>
                <div><dt><span className="legend-dot healthy" />Runner</dt><dd>{dashboard.data.runnerOnline ? 'Online' : 'Offline'}</dd></div>
              </dl>
              <p className="refresh-note"><span className="live-dot" /> Refreshes every 5 seconds</p>
            </aside>
          </section>
        </>
      )}
    </div>
  )
}
