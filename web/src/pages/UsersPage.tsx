import { FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { CmsAccount, CmsInvitation } from '../types'
import { cmsEmailSchema } from '../lib/validation'
import { EmptyState, ErrorState, FieldError, LoadingState, PageHeader, Toast } from '../components/ui'
import { formatRelativeTime } from '../lib/format'

export function UsersPage() {
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()
  const access = useQuery({ queryKey: ['cms-access'], queryFn: api.getCmsAccess })

  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['cms-access'] })
  const invite = useMutation({
    mutationFn: api.inviteCmsAccount,
    onSuccess: async () => { setEmail(''); setMessage('Invitation sent. The account will appear after the recipient accepts.'); await refresh() },
  })
  const resend = useMutation({ mutationFn: api.resendCmsInvitation, onSuccess: async () => { setMessage('Invitation resent.'); await refresh() } })
  const revoke = useMutation({ mutationFn: api.revokeCmsInvitation, onSuccess: async () => { setMessage('Invitation revoked.'); await refresh() } })
  const updateStatus = useMutation({
    mutationFn: ({ account, status }: { account: CmsAccount; status: 'active' | 'disabled' }) => api.updateCmsAccountStatus(account.id, status),
    onSuccess: async (account) => { setMessage(`${account.email} is now ${account.status}.`); await refresh() },
  })

  function submitInvite(event: FormEvent) {
    event.preventDefault()
    const parsed = cmsEmailSchema.safeParse(email)
    if (!parsed.success) { setEmailError(parsed.error.issues[0]?.message ?? 'Invalid email'); return }
    setEmailError('')
    invite.mutate(parsed.data.toLowerCase())
  }

  const mutationError = invite.error ?? resend.error ?? revoke.error ?? updateStatus.error
  const invitations = access.data?.invitations ?? []
  const pending = invitations.filter((item) => item.status === 'pending')
  const history = invitations.filter((item) => item.status !== 'pending')

  return <div className="page-stack">
    <PageHeader eyebrow="Access control" title="CMS access" description="Invite @matechmobile.com accounts and control member access. An account is created only after the recipient accepts the email invitation." />

    <section className="panel access-invite-panel">
      <div className="panel-header"><div><p className="panel-kicker">Invite member</p><h2>Send CMS invitation</h2></div></div>
      <form className="access-invite-form" onSubmit={submitInvite}>
        <label className="field"><span className="field-label">Company email</span><input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@matechmobile.com" /><FieldError message={emailError} /></label>
        <button className="button button-primary" disabled={invite.isPending || !email.trim()}>{invite.isPending ? 'Sending…' : 'Send invitation'}</button>
      </form>
    </section>

    {access.isLoading && <LoadingState label="Loading CMS access" />}
    {access.isError && <ErrorState error={access.error} onRetry={() => access.refetch()} />}

    {access.data && <>
      <AccessAccounts accounts={access.data.accounts} busy={updateStatus.isPending} onStatus={(account, status) => updateStatus.mutate({ account, status })} />
      <InvitationTable title="Pending invitations" invitations={pending} pending busy={resend.isPending || revoke.isPending} onResend={(id) => resend.mutate(id)} onRevoke={(id) => revoke.mutate(id)} />
      {history.length > 0 && <InvitationTable title="Invitation history" invitations={history} busy={false} onResend={() => undefined} onRevoke={() => undefined} />}
    </>}

    <Toast message={mutationError?.message ?? message} tone={mutationError ? 'error' : 'success'} />
  </div>
}

function AccessAccounts({ accounts, busy, onStatus }: { accounts: CmsAccount[]; busy: boolean; onStatus: (account: CmsAccount, status: 'active' | 'disabled') => void }) {
  if (accounts.length === 0) return <EmptyState title="No CMS members" description="Invite a company email. The member will appear here after accepting the invitation." />
  return <section className="panel user-table-panel"><div className="panel-header"><div><p className="panel-kicker">Members</p><h2>CMS accounts</h2></div></div><div className="table-scroll"><table><thead><tr><th>Account</th><th>Status</th><th>Accepted</th><th>Updated</th><th /></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}>
    <td><div className="user-cell"><span className="avatar">{account.email.slice(0, 1).toUpperCase()}</span><div><strong>{account.email}</strong><small>Member account</small></div></div></td>
    <td><span className={`project-state ${account.status === 'disabled' ? 'disabled' : ''}`}><span />{account.status}</span></td>
    <td>{formatRelativeTime(account.acceptedAt)}</td><td>{formatRelativeTime(account.updatedAt)}</td>
    <td><button className={`button button-small ${account.status === 'active' ? 'button-ghost danger-text' : 'button-secondary'}`} disabled={busy} onClick={() => onStatus(account, account.status === 'active' ? 'disabled' : 'active')}>{account.status === 'active' ? 'Disable' : 'Enable'}</button></td>
  </tr>)}</tbody></table></div></section>
}

function InvitationTable({ title, invitations, pending = false, busy, onResend, onRevoke }: { title: string; invitations: CmsInvitation[]; pending?: boolean; busy: boolean; onResend: (id: string) => void; onRevoke: (id: string) => void }) {
  return <section className="panel user-table-panel"><div className="panel-header"><div><p className="panel-kicker">Invitations</p><h2>{title}</h2></div></div>{invitations.length === 0 ? <div className="access-empty-row">No {title.toLowerCase()}.</div> : <div className="table-scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Sent</th><th>Expires</th><th /></tr></thead><tbody>{invitations.map((invitation) => <tr key={invitation.id}>
    <td><strong>{invitation.email}</strong></td><td><span className={`status-badge status-${invitation.status}`}><span className="status-dot" />{invitation.status}</span></td>
    <td>{invitation.sentAt ? formatRelativeTime(invitation.sentAt) : 'Not sent'}</td><td>{formatRelativeTime(invitation.expiresAt)}</td>
    <td>{pending && <div className="row-actions"><button className="button button-ghost button-small" disabled={busy} onClick={() => onResend(invitation.id)}>Resend</button><button className="button button-ghost button-small danger-text" disabled={busy} onClick={() => onRevoke(invitation.id)}>Revoke</button></div>}</td>
  </tr>)}</tbody></table></div>}</section>
}
