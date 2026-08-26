import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ApiError } from './api/client'
import { AdminRoute } from './components/AdminRoute'
import { AppShell } from './components/AppShell'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { BuildDetailPage } from './pages/BuildDetailPage'
import { BuildsPage } from './pages/BuildsPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { NewBuildPage } from './pages/NewBuildPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { ProjectFormPage } from './pages/ProjectFormPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { UsersPage } from './pages/UsersPage'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route path="/" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
            <Route index element={<DashboardPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<ProjectFormPage />} />
            <Route path="projects/:projectKey" element={<ProjectDetailPage />} />
            <Route path="projects/:projectKey/edit" element={<ProjectFormPage />} />
            <Route path="users" element={<AdminRoute><UsersPage /></AdminRoute>} />
            <Route path="builds" element={<BuildsPage />} />
            <Route path="builds/new" element={<NewBuildPage />} />
            <Route path="builds/:id" element={<BuildDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
