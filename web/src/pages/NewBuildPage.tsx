import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { EmptyState, ErrorState, FieldError, LoadingState, PageHeader } from '../components/ui'
import { buildTriggerSchema, firstZodError } from '../lib/validation'

export function NewBuildPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [projectKey, setProjectKey] = useState(searchParams.get('projectKey') ?? '')
  const [scheme, setScheme] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [buildNumber, setBuildNumber] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.getProjects })
  const selectedProject = useMemo(
    () => projects.data?.find((project) => project.projectKey === projectKey),
    [projectKey, projects.data],
  )
  useEffect(() => {
    setScheme(selectedProject?.scheme ?? '')
  }, [selectedProject?.projectKey])
  const trigger = useMutation({
    mutationFn: ({ projectKey: targetProjectKey, ...input }: { projectKey: string; appVersion: string; scheme: string; buildNumber: string; releaseNotes?: string }) => api.triggerBuild(targetProjectKey, input),
    onSuccess: (build) => navigate(`/builds/${build.id}`),
  })

  function submitBuild(event: FormEvent) {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!projectKey) nextErrors.projectKey = 'Select a project to build'
    else if (!selectedProject) nextErrors.projectKey = 'The selected project no longer exists'
    else if (!selectedProject.enabled) nextErrors.projectKey = 'The selected project is disabled'

    const parsed = buildTriggerSchema.safeParse({ appVersion, scheme, buildNumber, releaseNotes })
    if (!parsed.success) Object.assign(nextErrors, firstZodError(parsed.error))
    if (Object.keys(nextErrors).length > 0 || !selectedProject || !parsed.success) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    trigger.mutate({ projectKey: selectedProject.projectKey, ...parsed.data })
  }

  if (projects.isLoading) return <LoadingState label="Loading projects" />
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
  if (!projects.data?.length) {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="New delivery" title="Trigger build" description="Select an iOS project and queue a Fastlane delivery." />
        <EmptyState title="No projects configured" description="Create and validate an iOS project before triggering a build." action={<Link className="button button-primary" to="/projects/new">Create project</Link>} />
      </div>
    )
  }

  const enabledProjectCount = projects.data.filter((project) => project.enabled).length

  return (
    <div className="page-stack page-narrow">
      <div className="breadcrumb"><Link to="/builds">Builds</Link><span>/</span><span>New build</span></div>
      <PageHeader
        eyebrow="New delivery"
        title="Trigger build"
        description="Choose which iOS project to build. Each project keeps its own repository, Fastlane lane, scheme, Firebase app, and credentials."
      />

      {enabledProjectCount === 0 && (
        <div className="inline-alert" role="alert">
          No project is enabled. Validate and enable a project from <Link className="text-link" to="/projects">Projects</Link> first.
        </div>
      )}

      <form className="new-build-grid" onSubmit={submitBuild}>
        <section className="panel build-composer">
          <div className="panel-header">
            <div><p className="panel-kicker">Build request</p><h2>Delivery inputs</h2></div>
            <span className="keyboard-hint">Idempotent</span>
          </div>
          <div className="build-composer-body">
            <label className="field">
              <span className="field-label">iOS project</span>
              <select
                className="input select"
                value={projectKey}
                onChange={(event) => {
                  setProjectKey(event.target.value)
                  setErrors((current) => ({ ...current, projectKey: '' }))
                }}
              >
                <option value="">Select a project…</option>
                {projects.data.map((project) => (
                  <option key={project.projectKey} value={project.projectKey} disabled={!project.enabled}>
                    {project.displayName}{project.enabled ? '' : ' — disabled'}
                  </option>
                ))}
              </select>
              <FieldError message={errors.projectKey} />
            </label>

            <label className="field">
              <span className="field-label">Scheme</span>
              <input className="input mono" value={scheme} onChange={(event) => setScheme(event.target.value)} placeholder="PrankCall" />
              <FieldError message={errors.scheme} />
            </label>

            <label className="field">
              <span className="field-label">App version</span>
              <input className="input mono" value={appVersion} onChange={(event) => setAppVersion(event.target.value)} placeholder="1.1" />
              <FieldError message={errors.appVersion} />
            </label>

            <label className="field">
              <span className="field-label">Build number</span>
              <input className="input mono" value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} placeholder="6" />
              <FieldError message={errors.buildNumber} />
            </label>

            <label className="field">
              <span className="field-label">Release notes <small>Optional</small></span>
              <textarea className="input textarea" value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder="What changed in this build" />
              <FieldError message={errors.releaseNotes} />
            </label>

            {trigger.isError && <div className="inline-alert" role="alert">{trigger.error.message}</div>}
          </div>
          <div className="form-actions">
            <Link className="button button-ghost" to="/builds">Cancel</Link>
            <button className="button button-primary" disabled={!selectedProject?.enabled || trigger.isPending}>
              {trigger.isPending ? 'Queuing…' : 'Queue build'}
            </button>
          </div>
        </section>

        <aside className="panel selected-project-panel">
          <div className="panel-header"><div><p className="panel-kicker">Selected target</p><h2>Project configuration</h2></div></div>
          {selectedProject ? (
            <div className="selected-project-body">
              <div className="selected-project-heading">
                <div className="project-monogram" aria-hidden="true">{selectedProject.displayName.slice(0, 2).toUpperCase()}</div>
                <div><strong>{selectedProject.displayName}</strong><code>{selectedProject.projectKey}</code></div>
                <span className={`project-state ${selectedProject.enabled ? '' : 'disabled'}`}><span />{selectedProject.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <dl className="metadata-list">
                <div><dt>Fastlane lane</dt><dd className="mono">{selectedProject.fastlaneLane}</dd></div>
                <div><dt>Scheme</dt><dd>{selectedProject.scheme || 'Runner default'}</dd></div>
                <div><dt>Configuration</dt><dd>{selectedProject.buildConfiguration || 'Runner default'}</dd></div>
                <div><dt>Firebase app</dt><dd className="mono">{selectedProject.firebaseAppId}</dd></div>
                <div><dt>Tester groups</dt><dd>{selectedProject.firebaseTesterGroups.join(', ')}</dd></div>
                <div><dt>Validation</dt><dd>{selectedProject.validationStatus}</dd></div>
              </dl>
              <Link className="button button-secondary button-block" to={`/projects/${selectedProject.projectKey}`}>Open project settings</Link>
            </div>
          ) : (
            <div className="selected-project-empty">
              <span>⌁</span>
              <strong>No project selected</strong>
              <p>Select an enabled project to review the exact build target before queuing it.</p>
            </div>
          )}
        </aside>
      </form>
    </div>
  )
}
