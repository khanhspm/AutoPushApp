import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAdminToken } from '../hooks/useAuth'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = useAdminToken()
  const location = useLocation()
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />
  return children
}
