export type BuildStatus = 'enqueueing' | 'queued' | 'running' | 'success' | 'failed' | 'unknown'
export type BuildSource = 'cms' | 'lark'
export type SigningMode = 'manual' | 'match'

export interface ProvisioningProfileMapping {
  bundleId: string
  profileName: string
}

export interface Session {
  authenticated: boolean
  user?: { id?: string; name?: string; email?: string; role?: string }
}

export interface Project {
  projectKey: string
  displayName: string
  repoPath: string
  fastlaneLane: string
  scheme?: string | null
  buildConfiguration?: string | null
  firebaseAppId: string
  firebaseTesterGroups: string[]
  firebaseCliTokenEnvVar: string
  matchPasswordEnvVar?: string | null
  appStoreConnectKeyIdEnvVar?: string | null
  appStoreConnectIssuerIdEnvVar?: string | null
  appStoreConnectKeyPathEnvVar?: string | null
  signingMode: SigningMode
  appleTeamId?: string | null
  signingCertificate: string
  provisioningProfiles: ProvisioningProfileMapping[]
  larkNotificationChatId?: string | null
  enabled: boolean
  version: number
  validationStatus: 'valid' | 'invalid' | 'unknown'
  validationMessage?: string | null
  validatedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface ProjectInput {
  projectKey: string
  displayName: string
  repoPath: string
  fastlaneLane: string
  scheme?: string | null
  buildConfiguration?: string | null
  firebaseAppId: string
  firebaseTesterGroups: string[]
  firebaseCliTokenEnvVar: string
  matchPasswordEnvVar?: string | null
  appStoreConnectKeyIdEnvVar?: string | null
  appStoreConnectIssuerIdEnvVar?: string | null
  appStoreConnectKeyPathEnvVar?: string | null
  signingMode: SigningMode
  appleTeamId?: string | null
  signingCertificate: string
  provisioningProfiles: ProvisioningProfileMapping[]
  larkNotificationChatId?: string | null
  enabled: boolean
}

export interface ProjectUpdateInput extends Omit<ProjectInput, 'projectKey'> {
  version: number
}

export interface ProjectValidation {
  valid: boolean
  message?: string
  canonicalRepoPath?: string
  missingEnvironmentVariables?: string[]
}

export interface User {
  id: string
  displayName: string
  enabled: boolean
  projectKeys: string[]
  createdAt?: string
  updatedAt?: string
}

export interface UserCreateInput { id: string; displayName: string; enabled: boolean }
export interface UserUpdateInput { displayName: string; enabled: boolean }

export interface Build {
  id: string
  projectKey: string
  projectName?: string
  appVersion?: string | null
  requestedScheme?: string | null
  buildNumber: string
  releaseNotes?: string
  source: BuildSource
  status: BuildStatus
  requestedBy?: string | null
  attemptCount?: number
  retryOfId?: string | null
  failurePhase?: string | null
  createdAt: string
  queuedAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  errorMessage?: string | null
  artifactUrl?: string | null
}

export interface BuildDetail extends Build {
  configSnapshot?: Record<string, unknown>
}

export interface BuildLog {
  content: string
  truncated?: boolean
  complete?: boolean
}

export interface DashboardData {
  projectsTotal: number
  projectsEnabled: number
  buildsActive: number
  buildsQueued: number
  buildsSucceeded: number
  buildsFailed: number
  last24HoursSucceeded: number
  last24HoursFailed: number
  successRate?: number | null
  recentBuilds: Build[]
  runnerOnline?: boolean
}

export interface BuildListResult {
  items: Build[]
  nextCursor: string | null
}

export interface BuildFilters {
  projectKey?: string
  status?: string
  source?: string
  cursor?: string
  limit?: number
}

export interface ApiErrorBody {
  error?: string | { code?: string; message?: string; fields?: unknown }
  message?: string
  details?: unknown
}
