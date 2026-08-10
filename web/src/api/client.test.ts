import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'
import { getToken, setToken } from '../lib/auth'

describe('API authentication', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the bearer token and parses a session', async () => {
    setToken('admin-secret')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: { name: 'Ops Admin' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.getSession()).resolves.toMatchObject({ authenticated: true, user: { name: 'Ops Admin' } })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer admin-secret')
  })

  it('clears the stored token after a 401 response', async () => {
    setToken('expired-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(api.getSession()).rejects.toBeInstanceOf(ApiError)
    expect(getToken()).toBeNull()
  })
})
