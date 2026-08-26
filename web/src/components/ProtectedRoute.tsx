import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import { useSession } from '../hooks/useSession'
import { ErrorState, LoadingState } from './ui'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const session = useSession()
  const location = useLocation()

  if (session.isLoading) return <LoadingState label="Checking session" />
  if (session.error instanceof ApiError && session.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  if (session.isError) return <ErrorState error={session.error} onRetry={() => session.refetch()} />
  if (!session.data?.authenticated) return <Navigate to="/login" replace state={{ from: location }} />
  return children
}
