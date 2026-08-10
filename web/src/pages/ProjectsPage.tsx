import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { api } from '../api/client'
import type { Project } from '../types'
import { formatRelativeTime } from '../lib/format'
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, Toast } from '../components/ui'

export function ProjectsPage() {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.getProjects })
  const remove = useMutation({
    mutationFn: (projectKey: string) => api.deleteProject(projectKey),
    onSuccess: async () => {
      setDeleteTarget(null)
      setMessage('Project deleted.')
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Delivery configuration"
        title="Projects"
        description="Manage repositories, Xcode settings, validation, and build access."
        actions={<Link className="button button-primary" to="/projects/new">New project</Link>}
      />
      {projects.isLoading && <LoadingState label="Loading projects" />}
      {projects.isError && <ErrorState error={projects.error} onRetry={() => projects.refetch()} />}
      {projects.data && projects.data.length === 0 && (
        <EmptyState title="Add your first project" description="Configure a repository and scheme before triggering a build." action={<Link className="button button-primary" to="/projects/new">Create project</Link>} />
      )}
      {projects.data && projects.data.length > 0 && (
        <section className="project-grid">
          {projects.data.map((project) => (
            <article className="project-card" key={project.projectKey}>
              <div className="project-card-top">
                <div className="project-monogram" aria-hidden="true">{project.displayName.slice(0, 2).toUpperCase()}</div>
                <div className={`project-state ${project.enabled ? '' : 'disabled'}`}><span />{project.enabled ? 'Enabled' : 'Disabled'}</div>
              </div>
              <div className="project-card-body">
                <div><h2><Link to={`/projects/${project.projectKey}`}>{project.displayName}</Link></h2><code>{project.projectKey}</code></div>
                <p>{`Fastlane lane: ${project.fastlaneLane}`}</p>
                <dl className="project-meta">
                  <div><dt>Scheme</dt><dd>{project.scheme || '—'}</dd></div>
                  <div><dt>Configuration</dt><dd>{project.buildConfiguration || 'Default'}</dd></div>
                  <div><dt>Validated</dt><dd>{project.validatedAt ? formatRelativeTime(project.validatedAt) : 'Not yet'}</dd></div>
                </dl>
              </div>
              <div className="project-card-actions">
                <Link className="button button-primary button-small" to={project.enabled ? `/builds/new?projectKey=${encodeURIComponent(project.projectKey)}` : `/projects/${project.projectKey}`}>{project.enabled ? 'Build' : 'Validate'}</Link>
                <Link className="button button-secondary button-small" to={`/projects/${project.projectKey}`}>Open</Link>
                <Link className="button button-ghost button-small" to={`/projects/${project.projectKey}/edit`}>Edit</Link>
                <button className="button button-ghost button-small danger-text" type="button" onClick={() => setDeleteTarget(project)}>Delete</button>
              </div>
            </article>
          ))}
        </section>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete project?"
        description={`This permanently removes ${deleteTarget?.displayName ?? 'this project'} from AutoPush. Existing build history may remain.`}
        busy={remove.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.projectKey)}
      />
      <Toast message={remove.isError ? remove.error.message : message} tone={remove.isError ? 'error' : 'success'} />
    </div>
  )
}
