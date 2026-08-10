const TOKEN_KEY = 'autopush.adminToken'
export const AUTH_CHANGED_EVENT = 'autopush:auth-changed'

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
}

export function hasToken(): boolean {
  return Boolean(getToken())
}
