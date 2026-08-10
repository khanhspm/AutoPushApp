import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { User } from '../types'
import { firstZodError, userFormSchema, type UserFormValues } from '../lib/validation'
import { ConfirmDialog, EmptyState, ErrorState, FieldError, LoadingState, PageHeader, Toast } from '../components/ui'
import { formatRelativeTime } from '../lib/format'

const emptyUser: UserFormValues = { id: '', displayName: '', enabled: true }

export function UsersPage() {
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [values, setValues] = useState<UserFormValues>(emptyUser)
  const [permissions, setPermissions] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: api.getUsers })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.getProjects })

  useEffect(() => {
    if (editing && editing !== 'new') { setValues({ id: editing.id, displayName: editing.displayName, enabled: editing.enabled }); setPermissions(editing.projectKeys) }
    else if (editing === 'new') { setValues(emptyUser); setPermissions([]) }
    setErrors({})
  }, [editing])

  const save = useMutation({
    mutationFn: async (input: UserFormValues) => {
      const saved = editing === 'new'
        ? await api.createUser(input)
        : await api.updateUser((editing as User).id, { displayName: input.displayName, enabled: input.enabled })
      return api.updateUserPermissions(saved.id, permissions)
    },
    onSuccess: async () => { setEditing(null); setMessage('User access updated.'); await queryClient.invalidateQueries({ queryKey: ['users'] }) },
    onError: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })
  const remove = useMutation({ mutationFn: (id: string) => api.deleteUser(id), onSuccess: async () => { setDeleteTarget(null); setMessage('User deleted.'); await queryClient.invalidateQueries({ queryKey: ['users'] }) } })

  function submit(event: FormEvent) { event.preventDefault(); const parsed = userFormSchema.safeParse(values); if (!parsed.success) return setErrors(firstZodError(parsed.error)); save.mutate(parsed.data) }
  function togglePermission(key: string) { setPermissions((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]) }

  return <div className="page-stack">
    <PageHeader eyebrow="Access control" title="Users & permissions" description="Manage Lark user IDs and project-level build permission." actions={<button className="button button-primary" onClick={() => setEditing('new')}>Add user</button>} />
    {users.isLoading && <LoadingState label="Loading users" />}
    {users.isError && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
    {users.data && users.data.length === 0 && <EmptyState title="No users configured" description="Add a Lark user ID to delegate project build access." action={<button className="button button-primary" onClick={() => setEditing('new')}>Add user</button>} />}
    {users.data && users.data.length > 0 && <section className="panel user-table-panel"><div className="table-scroll"><table><thead><tr><th>User</th><th>User ID</th><th>Project access</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>{users.data.map((user) => <tr key={user.id}>
      <td><div className="user-cell"><span className="avatar">{user.displayName.slice(0,1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>Lark user</small></div></div></td>
      <td className="mono">{user.id}</td><td>{user.projectKeys.length ? `${user.projectKeys.length} project${user.projectKeys.length === 1 ? '' : 's'}` : <span className="muted">No access</span>}</td>
      <td><span className={`project-state ${user.enabled ? '' : 'disabled'}`}><span />{user.enabled ? 'Enabled' : 'Disabled'}</span></td><td>{formatRelativeTime(user.updatedAt ?? user.createdAt)}</td>
      <td><div className="row-actions"><button className="button button-ghost button-small" onClick={() => setEditing(user)}>Manage</button><button className="button button-ghost button-small danger-text" onClick={() => setDeleteTarget(user)}>Delete</button></div></td>
    </tr>)}</tbody></table></div></section>}

    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={() => !save.isPending && setEditing(null)}><form className="drawer-card" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
      <div className="drawer-header"><div><p className="eyebrow">Access management</p><h2>{editing === 'new' ? 'Add user' : `Manage ${(editing as User).displayName}`}</h2></div><button className="icon-button" type="button" onClick={() => setEditing(null)} aria-label="Close">×</button></div>
      <div className="drawer-body"><section className="drawer-section"><h3>Profile</h3><div className="form-grid">
        <label className="field"><span className="field-label">Lark user ID</span><input className="input mono" value={values.id} disabled={editing !== 'new'} onChange={(e) => setValues({ ...values, id: e.target.value })} placeholder="ou_xxxxxxxxx" /><FieldError message={errors.id} /></label>
        <label className="field"><span className="field-label">Display name</span><input className="input" value={values.displayName} onChange={(e) => setValues({ ...values, displayName: e.target.value })} /><FieldError message={errors.displayName} /></label>
        <label className="toggle-field field-full"><span><strong>User enabled</strong><small>Disabled users cannot request project builds.</small></span><input type="checkbox" checked={values.enabled} onChange={(e) => setValues({ ...values, enabled: e.target.checked })} /><span className="toggle" /></label>
      </div></section>
      <section className="drawer-section"><div className="section-inline-heading"><div><h3>Project permissions</h3><p>Choose projects this user can build.</p></div></div><div className="permission-list">{projects.data?.map((project) => <label className="permission-item" key={project.projectKey}><input type="checkbox" checked={permissions.includes(project.projectKey)} onChange={() => togglePermission(project.projectKey)} /><span className="custom-checkbox">✓</span><span className="project-monogram project-monogram-small">{project.displayName.slice(0,2).toUpperCase()}</span><span><strong>{project.displayName}</strong><small>{project.projectKey}</small></span></label>)}</div></section>
      {save.isError && <div className="inline-alert" role="alert">{save.error.message}</div>}</div>
      <div className="drawer-footer"><button className="button button-ghost" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save access'}</button></div>
    </form></div>}
    <ConfirmDialog open={Boolean(deleteTarget)} title="Delete user?" description={`${deleteTarget?.displayName ?? 'This user'} will lose build access immediately.`} busy={remove.isPending} onCancel={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)} />
    <Toast message={remove.isError ? remove.error.message : message} tone={remove.isError ? 'error' : 'success'} />
  </div>
}
