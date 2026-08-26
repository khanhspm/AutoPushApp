import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

export function AcceptInvitePage() {
  const [token, setToken] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    setToken(params.get('token') ?? '')
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }, [])

  const accept = useMutation({ mutationFn: () => api.acceptInvitation(token) })

  return <main className="login-page">
    <section className="login-panel" aria-labelledby="invite-title">
      <div className="login-brand"><div className="brand-mark brand-mark-large"><span>AP</span></div><span>AutoPush</span></div>
      <div className="login-copy">
        <p className="eyebrow">CMS invitation</p>
        <h1 id="invite-title">Accept your invitation</h1>
        <p>Your CMS account is created only after you confirm this invitation. You will then sign in with a one-time code sent to your company email.</p>
      </div>
      {!token && <div className="inline-alert" role="alert">This invitation link is missing its token.</div>}
      {accept.isError && <div className="inline-alert" role="alert"><strong>Could not accept invitation.</strong> {accept.error.message}</div>}
      {accept.isSuccess ? <div className="page-stack-small">
        <div className="inline-alert inline-alert-success"><strong>Invitation accepted.</strong> Your CMS account is now active.</div>
        <Link className="button button-primary button-block" to={`/login?email=${encodeURIComponent(accept.data.email)}`}>Sign in with OTP</Link>
      </div> : <button className="button button-primary button-block" disabled={!token || accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending ? 'Accepting…' : 'Accept invitation'}
      </button>}
      <p className="login-footnote">If you do not accept, no CMS account will be added.</p>
    </section>
    <aside className="login-visual" aria-hidden="true"><div className="visual-grid" /><div className="visual-content"><div className="visual-headline"><span>Confirm access.</span><strong>Operate securely.</strong></div></div></aside>
  </main>
}
