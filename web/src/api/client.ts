import { clearToken, getToken } from '../lib/auth'
import type {
  ApiErrorBody,
  Build,
  BuildDetail,
  BuildFilters,
  BuildListResult,
  BuildLog,
  DashboardData,
  Project,
  ProjectInput,
  ProjectUpdateInput,
  ProjectValidation,
  Session,
  User,
  UserCreateInput,
  UserUpdateInput,
} from '../types'
import { parseBuild, parseBuildDetail, parseBuilds, parseDashboard, parseProject, parseProjects, parseProjectValidation, parseSession, parseUser, parseUsers } from './schemas'

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> { body?: unknown }

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const requestToken = getToken()
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`)

  const response = await fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  if (response.status === 401 && getToken() === requestToken) clearToken()

  const contentType = response.headers.get('content-type') ?? ''
  const payload: unknown = response.status === 204
    ? undefined
    : contentType.includes('application/json')
      ? await response.json()
      : await response.text()

  if (!response.ok) {
    const body = payload && typeof payload === 'object' ? payload as ApiErrorBody : undefined
    const nestedError = body?.error && typeof body.error === 'object' ? body.error : undefined
    const message = nestedError?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : undefined) ?? (typeof payload === 'string' ? payload : response.statusText)
    throw new ApiError(message || 'Request failed', response.status, nestedError?.fields ?? body?.details)
  }
  return payload
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) })
  return params.size ? `?${params}` : ''
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const api = {
  async getSession(): Promise<Session> { return parseSession(await request('/api/session')) },
  async getDashboard(): Promise<DashboardData> { return parseDashboard(await request('/api/dashboard')) },
  async getProjects(): Promise<Project[]> { return parseProjects(await request('/api/projects')) },
  async getProject(projectKey: string): Promise<Project> { return parseProject(await request(`/api/projects/${encodeURIComponent(projectKey)}`)) },
  async createProject(input: ProjectInput): Promise<Project> {
    return parseProject(await request('/api/projects', { method: 'POST', body: input }))
  },
  async updateProject(projectKey: string, input: ProjectUpdateInput): Promise<Project> {
    return parseProject(await request(`/api/projects/${encodeURIComponent(projectKey)}`, { method: 'PUT', body: input }))
  },
  async deleteProject(projectKey: string): Promise<void> { await request(`/api/projects/${encodeURIComponent(projectKey)}`, { method: 'DELETE' }) },
  async validateProject(projectKey: string): Promise<ProjectValidation> {
    return parseProjectValidation(await request(`/api/projects/${encodeURIComponent(projectKey)}/validate`, { method: 'POST' }))
  },
  async triggerBuild(projectKey: string, input: { appVersion: string; scheme: string; buildNumber: string; releaseNotes?: string }, idempotencyKey = createIdempotencyKey()): Promise<Build> {
    return parseBuild(await request(`/api/projects/${encodeURIComponent(projectKey)}/builds`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: input }))
  },
  async getUsers(): Promise<User[]> { return parseUsers(await request('/api/users')) },
  async createUser(input: UserCreateInput): Promise<User> { return parseUser(await request('/api/users', { method: 'POST', body: input })) },
  async updateUser(id: string, input: UserUpdateInput): Promise<User> { return parseUser(await request(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body: input })) },
  async deleteUser(id: string): Promise<void> { await request(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  async updateUserPermissions(id: string, projectKeys: string[]): Promise<User> {
    return parseUser(await request(`/api/users/${encodeURIComponent(id)}/project-permissions`, { method: 'PUT', body: { projectKeys } }))
  },
  async getBuilds(filters: BuildFilters = {}): Promise<BuildListResult> {
    return parseBuilds(await request(`/api/builds${queryString({ projectKey: filters.projectKey, status: filters.status, source: filters.source, cursor: filters.cursor, limit: filters.limit })}`))
  },
  async getBuild(id: string): Promise<BuildDetail> { return parseBuildDetail(await request(`/api/builds/${encodeURIComponent(id)}`)) },
  async getBuildLog(id: string, tailBytes = 100_000): Promise<BuildLog> {
    const payload = await request(`/api/builds/${encodeURIComponent(id)}/log${queryString({ tailBytes })}`)
    if (typeof payload === 'string') return { content: payload }
    const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    return { content: String(raw.content ?? ''), truncated: typeof raw.truncated === 'boolean' ? raw.truncated : undefined, complete: typeof raw.complete === 'boolean' ? raw.complete : undefined }
  },
  async downloadBuildLog(id: string): Promise<Blob> {
    const requestToken = getToken()
    const response = await fetch(`/api/builds/${encodeURIComponent(id)}/log/download`, {
      headers: requestToken ? { Authorization: `Bearer ${requestToken}` } : undefined,
    })
    if (response.status === 401 && getToken() === requestToken) clearToken()
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiErrorBody | null
      const nested = payload?.error && typeof payload.error === 'object' ? payload.error : undefined
      throw new ApiError(nested?.message ?? 'Could not download build log', response.status, nested?.fields)
    }
    return response.blob()
  },
  async retryBuild(id: string, input: { appVersion?: string; scheme?: string; buildNumber?: string; releaseNotes?: string } = {}, idempotencyKey = createIdempotencyKey()): Promise<Build> {
    return parseBuild(await request(`/api/builds/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: input }))
  },
}
