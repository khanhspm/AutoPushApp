import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { ErrorState, LoadingState, PageHeader, StatusBadge, Toast } from '../components/ui'
import { formatBuildVersion, formatDateTime, formatDuration, titleCase } from '../lib/format'

function isActive(status?: string): boolean { return status === 'enqueueing' || status === 'queued' || status === 'running' }

export function BuildDetailPage() {
  const { id = '' } = useParams(); const navigate = useNavigate(); const queryClient = useQueryClient()
  const [tailBytes, setTailBytes] = useState(100_000); const [followLog, setFollowLog] = useState(true); const logRef = useRef<HTMLPreElement>(null)
  const build = useQuery({ queryKey: ['builds', id], queryFn: () => api.getBuild(id), refetchInterval: (query) => isActive(query.state.data?.status) ? 2_000 : false })
  const log = useQuery({ queryKey: ['builds', id, 'log', tailBytes], queryFn: () => api.getBuildLog(id, tailBytes), enabled: Boolean(build.data), refetchInterval: () => isActive(build.data?.status) ? 2_000 : false })
  const retry = useMutation({ mutationFn: () => api.retryBuild(id), onSuccess: async (next) => { await queryClient.invalidateQueries({ queryKey: ['builds'] }); navigate(`/builds/${next.id}`) } })
  const download = useMutation({ mutationFn: () => api.downloadBuildLog(id), onSuccess: (blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${id}.log`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0) } })
  useEffect(() => { if (followLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log.data?.content, followLog])

  if (build.isLoading) return <LoadingState label="Loading build" />
  if (build.isError || !build.data) return <ErrorState error={build.error} onRetry={() => build.refetch()} />
  const data = build.data
  const snapshotScheme = typeof data.configSnapshot?.scheme === 'string' ? data.configSnapshot.scheme : null
  const effectiveScheme = data.requestedScheme ?? snapshotScheme ?? 'Runner default'
  const duration = data.durationMs ?? (data.startedAt && isActive(data.status) ? Date.now() - new Date(data.startedAt).getTime() : undefined)

  return <div className="page-stack">
    <div className="breadcrumb"><Link to="/builds">Builds</Link><span>/</span><span>#{data.id.slice(0,8)}</span></div>
    <PageHeader eyebrow={<StatusBadge status={data.status} />} title={`Build ${formatBuildVersion(data.appVersion, data.buildNumber)}`} description={`${data.projectName ?? data.projectKey} · ${titleCase(data.source)} request · ${data.id}`} actions={<>{data.status === 'failed' && data.appVersion && <button className="button button-primary" onClick={() => retry.mutate()} disabled={retry.isPending}>{retry.isPending ? 'Queuing retry…' : 'Retry build'}</button>}<Link className="button button-secondary" to={`/projects/${data.projectKey}`}>Open project</Link></>} />
    <section className="build-summary-grid"><article><span>Started</span><strong>{formatDateTime(data.startedAt ?? data.queuedAt ?? data.createdAt)}</strong></article><article><span>Duration</span><strong>{formatDuration(duration)}</strong></article><article><span>Requested by</span><strong>{data.requestedBy || 'System'}</strong></article><article><span>Source</span><strong>{titleCase(data.source)}</strong></article><article><span>Attempts</span><strong>{data.attemptCount ?? 0}</strong></article></section>
    {data.errorMessage && <div className="build-error-banner" role="alert"><span>!</span><div><strong>Build failed{data.failurePhase ? ` during ${data.failurePhase}` : ''}</strong><p>{data.errorMessage}</p></div></div>}
    <section className="build-detail-grid">
      <article className="panel log-panel"><div className="panel-header log-toolbar"><div><p className="panel-kicker">Runner output</p><h2>Build log</h2></div><div className="log-controls"><label>Tail <select className="input select input-small" value={tailBytes} onChange={(e) => setTailBytes(Number(e.target.value))}><option value={50_000}>50 KB</option><option value={100_000}>100 KB</option><option value={250_000}>250 KB</option></select></label><label className="checkbox-label"><input type="checkbox" checked={followLog} onChange={(e) => setFollowLog(e.target.checked)} /> Follow</label><button className="button button-secondary button-small" onClick={() => log.refetch()} disabled={log.isFetching}>Refresh</button><button className="button button-secondary button-small" onClick={() => download.mutate()} disabled={download.isPending}>{download.isPending ? 'Downloading…' : 'Download full log'}</button></div></div>
        {log.isError ? <ErrorState error={log.error} onRetry={() => log.refetch()} /> : <div className="log-frame"><div className="log-frame-header"><span className="terminal-dots"><i /><i /><i /></span><span>{data.projectKey} / {data.id}.log</span>{isActive(data.status) && <span className="log-live"><i /> Live</span>}</div><pre ref={logRef} tabIndex={0} aria-label="Build log output">{log.isLoading ? 'Loading log…' : log.data?.content || 'No log output is available yet.'}</pre>{log.data?.truncated && <div className="log-truncated">Showing the latest {Math.round(tailBytes / 1000)} KB of output.</div>}</div>}
      </article>
      <aside className="panel compact-panel build-metadata"><h2>Build metadata</h2><dl className="metadata-list"><div><dt>Build ID</dt><dd className="mono">{data.id}</dd></div><div><dt>Project</dt><dd className="mono">{data.projectKey}</dd></div><div><dt>Selected scheme</dt><dd className="mono">{data.requestedScheme || 'Project default'}</dd></div><div><dt>Effective scheme</dt><dd className="mono">{effectiveScheme}</dd></div><div><dt>App version</dt><dd className="mono">{data.appVersion || '—'}</dd></div><div><dt>Build number</dt><dd className="mono">{data.buildNumber}</dd></div><div><dt>Retry of</dt><dd className="mono">{data.retryOfId || '—'}</dd></div><div><dt>Queued</dt><dd>{formatDateTime(data.queuedAt)}</dd></div><div><dt>Finished</dt><dd>{formatDateTime(data.finishedAt)}</dd></div></dl>{data.releaseNotes && <div className="release-notes"><h3>Release notes</h3><p>{data.releaseNotes}</p></div>}</aside>
    </section>
    <p className="refresh-note build-refresh-note">{isActive(data.status) ? <><span className="live-dot" /> Build and log refresh every 2 seconds</> : <>Build completed · automatic refresh paused</>}</p><Toast message={retry.isError ? retry.error.message : download.isError ? download.error.message : undefined} tone="error" />
  </div>
}
