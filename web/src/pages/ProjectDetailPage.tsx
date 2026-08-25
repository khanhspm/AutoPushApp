import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { buildTriggerSchema, firstZodError } from '../lib/validation'
import { formatDateTime } from '../lib/format'
import { ConfirmDialog, ErrorState, FieldError, LoadingState, PageHeader, Toast } from '../components/ui'

export function ProjectDetailPage() {
  const { projectKey = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [scheme, setScheme] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [buildNumber, setBuildNumber] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteOpen, setDeleteOpen] = useState(false)
  const project = useQuery({ queryKey: ['projects', projectKey], queryFn: () => api.getProject(projectKey) })
  useEffect(() => {
    setScheme(project.data?.scheme ?? '')
  }, [project.data?.projectKey])
  const setup = useMutation({
    mutationFn: () => api.setupAndValidateProject(projectKey),
    onSuccess: (result) => {
      queryClient.setQueryData(['projects', projectKey], result.project)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const trigger = useMutation({ mutationFn: (input: { appVersion: string; scheme: string; buildNumber: string; releaseNotes?: string }) => api.triggerBuild(projectKey, input), onSuccess: (build) => navigate(`/builds/${build.id}`) })
  const remove = useMutation({ mutationFn: () => api.deleteProject(projectKey), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate('/projects', { replace: true }) } })

  function submitBuild(event: FormEvent) {
    event.preventDefault(); const parsed = buildTriggerSchema.safeParse({ appVersion, scheme, buildNumber, releaseNotes })
    if (!parsed.success) return setErrors(firstZodError(parsed.error))
    setErrors({}); trigger.mutate(parsed.data)
  }
  if (project.isLoading) return <LoadingState label="Loading project" />
  if (project.isError || !project.data) return <ErrorState error={project.error} onRetry={() => project.refetch()} />
  const data = project.data
  const validation = setup.data?.validation
  const validationValid = validation?.valid ?? data.validationStatus === 'valid'
  const validationMessage = validation?.message || data.validationMessage || 'Configure Bundler dependencies, then validate repository access and runner environment variables.'

  return <div className="page-stack">
    <div className="breadcrumb"><Link to="/projects">Projects</Link><span>/</span><span>{data.displayName}</span></div>
    <PageHeader eyebrow={<span className={`project-state ${data.enabled ? '' : 'disabled'}`}><span />{data.enabled ? 'Enabled' : 'Disabled'}</span>} title={data.displayName} description={`Project key: ${data.projectKey}`} actions={<><Link className="button button-secondary" to={`/projects/${projectKey}/edit`}>Edit settings</Link><button className="button button-ghost danger-text" onClick={() => setDeleteOpen(true)}>Delete</button></>} />
    <section className="detail-grid">
      <div className="detail-main page-stack-small">
        <article className="panel build-trigger-card">
          <div className="panel-header"><div><p className="panel-kicker">New delivery</p><h2>Trigger build</h2></div><span className="keyboard-hint">Idempotent</span></div>
          <form className="build-trigger-form" onSubmit={submitBuild}>
            <label className="field"><span className="field-label">Scheme</span><input className="input mono" value={scheme} onChange={(e) => setScheme(e.target.value)} placeholder="PrankCall" /><FieldError message={errors.scheme} /></label>
            <label className="field"><span className="field-label">App version</span><input className="input mono" value={appVersion} onChange={(e) => setAppVersion(e.target.value)} placeholder="1.1" /><FieldError message={errors.appVersion} /></label>
            <label className="field"><span className="field-label">Build number</span><input className="input mono" value={buildNumber} onChange={(e) => setBuildNumber(e.target.value)} placeholder="6" /><FieldError message={errors.buildNumber} /></label>
            <label className="field"><span className="field-label">Release notes <small>Optional</small></span><input className="input" value={releaseNotes} onChange={(e) => setReleaseNotes(e.target.value)} placeholder="What changed in this build" /></label>
            <button className="button button-primary" disabled={!data.enabled || trigger.isPending}>{trigger.isPending ? 'Queuing…' : 'Queue build'}</button>
          </form>
          {!data.enabled && <p className="form-note warning-text">Run Setup &amp; Validate, then enable this project before triggering builds.</p>}
          {trigger.isError && <div className="inline-alert" role="alert">{trigger.error.message}</div>}
        </article>
        <article className="panel"><div className="panel-header"><div><p className="panel-kicker">Runner inputs</p><h2>Build configuration</h2></div></div><dl className="definition-grid">
          <div><dt>Repository</dt><dd className="mono">{data.repoPath}</dd></div><div><dt>Fastlane lane</dt><dd className="mono">{data.fastlaneLane}</dd></div>
          <div><dt>Scheme</dt><dd>{data.scheme || 'Runner default'}</dd></div><div><dt>Configuration</dt><dd>{data.buildConfiguration || 'Runner default'}</dd></div>
          <div><dt>Firebase app</dt><dd className="mono">{data.firebaseAppId}</dd></div><div><dt>Tester groups</dt><dd>{data.firebaseTesterGroups.join(', ')}</dd></div>
          <div><dt>Firebase token env</dt><dd className="mono">{data.firebaseCliTokenEnvVar}</dd></div><div><dt>Signing mode</dt><dd>{data.signingMode === 'manual' ? 'Manual · ad-hoc' : 'Fastlane Match · ad-hoc'}</dd></div>
          <div className="definition-wide"><dt>Lark notification group</dt><dd className="mono">{data.larkNotificationChatId || 'Not configured'}</dd></div>
          {data.signingMode === 'match' ? <>
            <div><dt>Match password env</dt><dd className="mono">{data.matchPasswordEnvVar || '—'}</dd></div><div><dt>ASC key ID env</dt><dd className="mono">{data.appStoreConnectKeyIdEnvVar || '—'}</dd></div>
            <div><dt>ASC issuer ID env</dt><dd className="mono">{data.appStoreConnectIssuerIdEnvVar || '—'}</dd></div><div><dt>ASC key path env</dt><dd className="mono">{data.appStoreConnectKeyPathEnvVar || '—'}</dd></div>
          </> : <>
            <div><dt>Apple Team ID</dt><dd className="mono">{data.appleTeamId || '—'}</dd></div><div><dt>Signing certificate</dt><dd>{data.signingCertificate}</dd></div>
            <div className="definition-wide"><dt>Provisioning profiles</dt><dd className="signing-profile-list">{data.provisioningProfiles.map((profile) => <span key={profile.bundleId}><code>{profile.bundleId}</code><span>→</span><strong>{profile.profileName}</strong></span>)}</dd></div>
          </>}
        </dl></article>
      </div>
      <aside className="page-stack-small">
        <article className="panel validation-card" aria-busy={setup.isPending}>
          <div className="validation-heading"><div className={`validation-icon ${validationValid ? 'valid' : ''}`}>{validationValid ? '✓' : '?'}</div><div><h2>Setup &amp; validation</h2><p>{validationMessage}</p></div></div>
          {validation?.missingEnvironmentVariables?.length ? <div className="inline-alert">Missing: {validation.missingEnvironmentVariables.join(', ')}</div> : null}
          {setup.isPending && <p className="form-note">Configuring Bundler and installing missing dependencies. This can take several minutes.</p>}
          {setup.isSuccess && <p className="form-note">{setup.data.dependenciesInstalled ? 'Dependencies installed in vendor/bundle.' : 'Dependencies were already installed.'}</p>}
          <button className="button button-secondary button-block" onClick={() => setup.mutate()} disabled={setup.isPending}>{setup.isPending ? 'Setting up & validating…' : 'Setup & Validate'}</button>
          {setup.isError && <p className="field-error">{setup.error.message}</p>}
        </article>
        <article className="panel compact-panel"><h3>Project metadata</h3><dl className="metadata-list"><div><dt>Version</dt><dd>{data.version}</dd></div><div><dt>Created</dt><dd>{formatDateTime(data.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatDateTime(data.updatedAt)}</dd></div><div><dt>Last validated</dt><dd>{formatDateTime(data.validatedAt)}</dd></div></dl></article>
      </aside>
    </section>
    <ConfirmDialog open={deleteOpen} title="Delete project?" description={`This permanently removes ${data.displayName} from AutoPush.`} busy={remove.isPending} onCancel={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} />
    <Toast message={remove.isError ? remove.error.message : undefined} tone="error" />
  </div>
}
