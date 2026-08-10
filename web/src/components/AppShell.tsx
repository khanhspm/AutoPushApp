import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { clearToken } from '../lib/auth'

const navigation = [
  { to: '/', label: 'Dashboard', icon: 'grid' },
  { to: '/projects', label: 'Projects', icon: 'box' },
  { to: '/users', label: 'Users', icon: 'users' },
  { to: '/builds', label: 'Builds', icon: 'activity' },
]

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, JSX.Element> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    box: <><path d="m21 8-9 5-9-5"/><path d="m3 8 9-5 9 5v8l-9 5-9-5Z"/><path d="M12 13v8"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  }
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: api.getSession, staleTime: 60_000 })

  function signOut() {
    clearToken()
    queryClient.clear()
    navigate('/login', { replace: true })
  }

  const identity = session.data?.user?.name ?? session.data?.user?.email ?? 'Administrator'

  return (
    <div className="app-shell">
      <button
        className={`sidebar-overlay ${menuOpen ? 'is-open' : ''}`}
        aria-label="Close navigation"
        onClick={() => setMenuOpen(false)}
      />
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>AP</span></div>
          <div><strong>AutoPush</strong><small>Operations console</small></div>
        </div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <p className="nav-section-label">Workspace</p>
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="environment-chip"><span /> API protected</div>
          <button className="account-button" type="button" onClick={signOut}>
            <span className="avatar">{identity.slice(0, 1).toUpperCase()}</span>
            <span><strong>{identity}</strong><small>Sign out</small></span>
            <span className="signout-icon" aria-hidden="true">↗</span>
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation">☰</button>
          <div className="mobile-brand">AutoPush</div>
          <span className="avatar avatar-small">{identity.slice(0, 1).toUpperCase()}</span>
        </header>
        <main className="page-content"><Outlet /></main>
      </div>
    </div>
  )
}
