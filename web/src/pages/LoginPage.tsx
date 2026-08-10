import { FormEvent, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { clearToken, setToken } from '../lib/auth'
import { useAdminToken } from '../hooks/useAuth'

export function LoginPage() {
  const [tokenValue, setTokenValue] = useState('')
  const [showToken, setShowToken] = useState(false)
  const token = useAdminToken()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const from = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from
  const destination = from ? `${from.pathname ?? '/'}${from.search ?? ''}${from.hash ?? ''}` : '/'

  const login = useMutation({
    mutationFn: async (adminToken: string) => {
      setToken(adminToken)
      try {
        return await api.getSession()
      } catch (error) {
        clearToken()
        throw error
      }
    },
    onSuccess: (session) => {
      queryClient.clear()
      queryClient.setQueryData(['session'], session)
      navigate(destination, { replace: true })
    },
  })

  if (token && !login.isPending) return <Navigate to="/" replace />

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = tokenValue.trim()
    if (trimmed) login.mutate(trimmed)
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <div className="brand-mark brand-mark-large" aria-hidden="true"><span>AP</span></div>
          <span>AutoPush</span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Protected workspace</p>
          <h1 id="login-title">Sign in to the operations console</h1>
          <p>Use the administrator token configured for your AutoPush environment.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="field-label" htmlFor="admin-token">Admin token</label>
          <div className="token-input-wrap">
            <input
              id="admin-token"
              className="input"
              type={showToken ? 'text' : 'password'}
              value={tokenValue}
              onChange={(event) => setTokenValue(event.target.value)}
              placeholder="Paste your bearer token"
              autoComplete="current-password"
              autoFocus
              required
            />
            <button type="button" onClick={() => setShowToken((value) => !value)}>
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          {login.isError && (
            <div className="inline-alert" role="alert">
              <strong>Sign-in failed.</strong> {login.error.message}
            </div>
          )}
          <button className="button button-primary button-block" disabled={login.isPending || !tokenValue.trim()}>
            {login.isPending ? <><span className="spinner spinner-light" /> Verifying…</> : 'Continue to console'}
          </button>
        </form>
        <p className="login-footnote">The token stays in this browser tab and is cleared when the session ends.</p>
      </section>
      <aside className="login-visual" aria-hidden="true">
        <div className="visual-grid" />
        <div className="visual-content">
          <div className="signal-card signal-card-one">
            <span className="signal-icon success">✓</span>
            <div><strong>Build completed</strong><small>ios-release · 2m ago</small></div>
          </div>
          <div className="signal-card signal-card-two">
            <span className="signal-icon running">↻</span>
            <div><strong>Pipeline running</strong><small>staging · Step 4 of 7</small></div>
          </div>
          <div className="visual-headline"><span>Ship confidently.</span><strong>Operate clearly.</strong></div>
        </div>
      </aside>
    </main>
  )
}
