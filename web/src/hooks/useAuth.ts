import { useSyncExternalStore } from 'react'
import { AUTH_CHANGED_EVENT, getToken } from '../lib/auth'

function subscribe(callback: () => void): () => void {
  window.addEventListener(AUTH_CHANGED_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(AUTH_CHANGED_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

export function useAdminToken(): string | null {
  return useSyncExternalStore(subscribe, getToken, () => null)
}
