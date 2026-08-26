import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'

export function AdminRoute({ children }: { children: ReactNode }) {
  const session = useSession()
  if (session.data?.user?.role !== 'admin') return <Navigate to="/" replace />
  return children
}
