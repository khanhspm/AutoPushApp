import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AcceptInvitePage } from './AcceptInvitePage'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><BrowserRouter><AcceptInvitePage /></BrowserRouter></QueryClientProvider>)
}

describe('AcceptInvitePage', () => {
  it('removes the invite fragment and activates only after explicit acceptance', async () => {
    window.history.replaceState(null, '', '/accept-invite#token=invite-secret-token-that-is-long-enough')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ account: {
      id: 'account-1', email: 'member@matechmobile.com', status: 'active', acceptedAt: '2026-08-26T00:00:00.000Z', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    renderPage()
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await screen.findByText('Invitation accepted.')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/invitations/accept', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'invite-secret-token-that-is-long-enough' }),
    }))
  })
})
