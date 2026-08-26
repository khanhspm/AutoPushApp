import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: api.getSession,
    retry: false,
    staleTime: 60_000,
  })
}
