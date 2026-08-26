import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { clearToken, setToken } from '../lib/auth'

export function LoginPage() {
  const [searchParams] = useSearchParams()
  const [email, setEmail] = useState(searchParams.get('email') ?? '')
  const [challengeId, setChallengeId] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [tokenValue, setTokenValue] = useState('')
  const [showAdmin, setShowAdmin] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const from = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from
  const destination = from ? `${from.pathname ?? '/'}${from.search ?? ''}${from.hash ?? ''}` : '/'

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  function finishLogin(session: Awaited<ReturnType<typeof api.getSession>>) {
    queryClient.clear()
    queryClient.setQueryData(['session'], session)
    navigate(destination, { replace: true })
  }

  const requestOtp = useMutation({
    mutationFn: async () => {
      clearToken()
      return api.requestOtp(email.trim())
    },
    onSuccess: (result) => {
      setChallengeId(result.challengeId)
      setCooldown(60)
    },
  })

  const verifyOtp = useMutation({
    mutationFn: () => api.verifyOtp(challengeId, code.trim()),
    onSuccess: finishLogin,
  })

  const adminLogin = useMutation({
    mutationFn: async (adminToken: string) => {
      setToken(adminToken)
      try {
        const session = await api.getSession()
        if (session.user?.role !== 'admin') throw new Error('This credential is not an administrator token')
        return session
      } catch (error) {
        clearToken()
        throw error
      }
    },
    onSuccess: finishLogin,
  })

  function submitEmail(event: FormEvent) {
    event.preventDefault()
    if (email.trim()) requestOtp.mutate()
  }

  function submitCode(event: FormEvent) {
    event.preventDefault()
    if (/^\d{6}$/.test(code.trim())) verifyOtp.mutate()
  }

  function submitAdmin(event: FormEvent) {
    event.preventDefault()
    const trimmed = tokenValue.trim()
    if (trimmed) adminLogin.mutate(trimmed)
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand"><div className="brand-mark brand-mark-large" aria-hidden="true"><span>AP</span></div><span>AutoPush</span></div>
        <div className="login-copy">
          <p className="eyebrow">Protected workspace</p>
          <h1 id="login-title">Sign in to the operations console</h1>
          <p>Use your <strong>@matechmobile.com</strong> email and the one-time code sent to your inbox.</p>
        </div>

        {!challengeId ? <form className="login-form" onSubmit={submitEmail}>
          <label className="field-label" htmlFor="member-email">Company email</label>
          <input id="member-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@matechmobile.com" autoComplete="email" autoFocus required />
          {requestOtp.isError && <div className="inline-alert" role="alert"><strong>Could not send code.</strong> {requestOtp.error.message}</div>}
          <button className="button button-primary button-block" disabled={requestOtp.isPending || !email.trim()}>
            {requestOtp.isPending ? <><span className="spinner spinner-light" /> Sending…</> : 'Send sign-in code'}
          </button>
        </form> : <form className="login-form" onSubmit={submitCode}>
          <div className="login-step-heading"><strong>Check your inbox</strong><small>Enter the 6-digit code sent to {email.trim()}.</small></div>
          <label className="field-label" htmlFor="otp-code">One-time code</label>
          <input id="otp-code" className="input mono otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" autoFocus required />
          {verifyOtp.isError && <div className="inline-alert" role="alert"><strong>Sign-in failed.</strong> {verifyOtp.error.message}</div>}
          <button className="button button-primary button-block" disabled={verifyOtp.isPending || !/^\d{6}$/.test(code)}>{verifyOtp.isPending ? 'Verifying…' : 'Continue to console'}</button>
          <div className="login-secondary-actions">
            <button className="button button-ghost button-small" type="button" onClick={() => { setChallengeId(''); setCode('') }}>Use another email</button>
            <button className="button button-ghost button-small" type="button" disabled={cooldown > 0 || requestOtp.isPending} onClick={() => requestOtp.mutate()}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</button>
          </div>
        </form>}

        <div className="admin-login-divider"><span>Administrator</span></div>
        {!showAdmin ? <button className="button button-secondary button-block" type="button" onClick={() => setShowAdmin(true)}>Use administrator token</button> : <form className="login-form admin-login-form" onSubmit={submitAdmin}>
          <label className="field-label" htmlFor="admin-token">Admin token</label>
          <div className="token-input-wrap">
            <input id="admin-token" className="input" type={showToken ? 'text' : 'password'} value={tokenValue} onChange={(event) => setTokenValue(event.target.value)} placeholder="Paste your bearer token" autoComplete="current-password" required />
            <button type="button" onClick={() => setShowToken((value) => !value)}>{showToken ? 'Hide' : 'Show'}</button>
          </div>
          {adminLogin.isError && <div className="inline-alert" role="alert"><strong>Admin sign-in failed.</strong> {adminLogin.error.message}</div>}
          <button className="button button-secondary button-block" disabled={adminLogin.isPending || !tokenValue.trim()}>{adminLogin.isPending ? 'Verifying…' : 'Continue as administrator'}</button>
        </form>}
        <p className="login-footnote">Member sessions expire after 3 days. Administrator tokens remain in this browser tab only.</p>
      </section>
      <aside className="login-visual" aria-hidden="true">
        <div className="visual-grid" />
        <div className="visual-content">
          <div className="signal-card signal-card-one"><span className="signal-icon success">✓</span><div><strong>Build completed</strong><small>ios-release · 2m ago</small></div></div>
          <div className="signal-card signal-card-two"><span className="signal-icon running">↻</span><div><strong>Pipeline running</strong><small>staging · Step 4 of 7</small></div></div>
          <div className="visual-headline"><span>Ship confidently.</span><strong>Operate clearly.</strong></div>
        </div>
      </aside>
    </main>
  )
}
