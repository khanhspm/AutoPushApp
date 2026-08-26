import { z } from 'zod'
import type { Build, BuildDetail, BuildListResult, CmsAccessOverview, CmsAccount, CmsInvitation, DashboardData, Project, ProjectSetupResult, ProjectValidation, RepositoryCandidate, RepositoryDiscoveryResult, Session, SigningDiscoveryResult, SigningProfileImportResult, User } from '../types'

const unknownObject = z.object({}).passthrough()
const recordSchema = z.record(z.unknown())

function object(value: unknown): Record<string, unknown> {
  return unknownObject.parse(value)
}
function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true') return true
  if (value === 0 || value === 'false') return false
  return fallback
}
function unwrap(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const parsed = object(value)
  for (const key of keys) if (key in parsed) return parsed[key]
  return value
}

export function parseSession(value: unknown): Session {
  const raw = object(unwrap(value, ['session', 'data']))
  const userRaw = raw.user && typeof raw.user === 'object' ? object(raw.user) : undefined
  const role = optionalString(userRaw?.role)
  return {
    authenticated: booleanValue(raw.authenticated, true),
    expiresAt: optionalString(raw.expiresAt),
    user: userRaw ? {
      id: optionalString(userRaw.id),
      name: optionalString(userRaw.name ?? userRaw.displayName),
      email: optionalString(userRaw.email),
      role: role === 'admin' || role === 'member' ? role : undefined,
    } : undefined,
  }
}

export function parseCmsAccount(value: unknown): CmsAccount {
  const raw = object(unwrap(value, ['account', 'data']))
  return {
    id: stringValue(raw.id),
    email: stringValue(raw.email),
    status: stringValue(raw.status) === 'disabled' ? 'disabled' : 'active',
    acceptedAt: stringValue(raw.acceptedAt),
    createdAt: stringValue(raw.createdAt),
    updatedAt: stringValue(raw.updatedAt),
  }
}

function parseCmsInvitation(value: unknown): CmsInvitation {
  const raw = object(value)
  const status = stringValue(raw.status)
  return {
    id: stringValue(raw.id),
    email: stringValue(raw.email),
    status: status === 'accepted' || status === 'expired' || status === 'revoked' ? status : 'pending',
    expiresAt: stringValue(raw.expiresAt),
    sentAt: optionalString(raw.sentAt),
    acceptedAt: optionalString(raw.acceptedAt),
    createdAt: stringValue(raw.createdAt),
  }
}

export function parseCmsAccess(value: unknown): CmsAccessOverview {
  const raw = object(unwrap(value, ['data']))
  return {
    accounts: Array.isArray(raw.accounts) ? raw.accounts.map(parseCmsAccount) : [],
    invitations: Array.isArray(raw.invitations) ? raw.invitations.map(parseCmsInvitation) : [],
  }
}

export function parseProject(value: unknown): Project {
  const raw = object(unwrap(value, ['project', 'data']))
  const validationStatus = stringValue(raw.validationStatus ?? raw.validation_status, 'unknown')
  const testerGroups = raw.firebaseTesterGroups ?? raw.firebase_tester_groups
  const signingMode = stringValue(raw.signingMode ?? raw.signing_mode, 'match')
  const profileValues = raw.provisioningProfiles ?? raw.provisioning_profiles
  const provisioningProfiles = Array.isArray(profileValues)
    ? profileValues.map((value) => object(value)).map((profile) => ({
        bundleId: stringValue(profile.bundleId ?? profile.bundle_id),
        profileName: stringValue(profile.profileName ?? profile.profile_name),
        profileUuid: optionalString(profile.profileUuid ?? profile.profile_uuid),
      }))
    : []
  return {
    projectKey: stringValue(raw.projectKey ?? raw.project_key ?? raw.key),
    displayName: stringValue(raw.displayName ?? raw.display_name ?? raw.name, stringValue(raw.projectKey ?? raw.key)),
    repoPath: stringValue(raw.repoPath ?? raw.repo_path),
    fastlaneLane: stringValue(raw.fastlaneLane ?? raw.fastlane_lane),
    scheme: optionalString(raw.scheme),
    buildConfiguration: optionalString(raw.buildConfiguration ?? raw.build_configuration),
    firebaseAppId: stringValue(raw.firebaseAppId ?? raw.firebase_app_id),
    firebaseTesterGroups: Array.isArray(testerGroups) ? testerGroups.map(String) : [],
    firebaseCliTokenEnvVar: stringValue(raw.firebaseCliTokenEnvVar ?? raw.firebase_cli_token_env_var),
    matchPasswordEnvVar: optionalString(raw.matchPasswordEnvVar ?? raw.match_password_env_var),
    appStoreConnectKeyIdEnvVar: optionalString(raw.appStoreConnectKeyIdEnvVar ?? raw.app_store_connect_key_id_env_var),
    appStoreConnectIssuerIdEnvVar: optionalString(raw.appStoreConnectIssuerIdEnvVar ?? raw.app_store_connect_issuer_id_env_var),
    appStoreConnectKeyPathEnvVar: optionalString(raw.appStoreConnectKeyPathEnvVar ?? raw.app_store_connect_key_path_env_var),
    signingMode: signingMode === 'manual' ? 'manual' : 'match',
    appleTeamId: optionalString(raw.appleTeamId ?? raw.apple_team_id),
    signingCertificate: stringValue(raw.signingCertificate ?? raw.signing_certificate, 'Apple Distribution'),
    provisioningProfiles,
    larkNotificationChatId: optionalString(raw.larkNotificationChatId ?? raw.lark_notification_chat_id),
    enabled: booleanValue(raw.enabled),
    version: numberValue(raw.version, 1),
    validationStatus: validationStatus === 'valid' || validationStatus === 'invalid' ? validationStatus : 'unknown',
    validationMessage: optionalString(raw.validationMessage ?? raw.validation_message),
    validatedAt: optionalString(raw.validatedAt ?? raw.validated_at),
    createdAt: optionalString(raw.createdAt ?? raw.created_at),
    updatedAt: optionalString(raw.updatedAt ?? raw.updated_at),
  }
}

export function parseProjects(value: unknown): Project[] {
  return z.array(z.unknown()).parse(unwrap(value, ['projects', 'items', 'data'])).map(parseProject)
}

const signingDiscoveryWarningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
}).strict()
const signingCertificateCandidateSchema = z.object({
  name: z.string().trim().min(1),
  sha1Fingerprint: z.string().regex(/^[A-F0-9]{40}$/),
  kind: z.enum(['distribution', 'development', 'other']),
}).strict()
const signingProfileCandidateSchema = z.object({
  profileName: z.string().trim().min(1),
  uuid: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  teamName: z.string().trim().min(1).nullable(),
  expiresAt: z.string().datetime(),
  certificateCandidates: z.array(signingCertificateCandidateSchema),
  recommendedCertificate: signingCertificateCandidateSchema.nullable(),
  warnings: z.array(signingDiscoveryWarningSchema),
}).strict()
const signingDiscoverySchema = z.object({
  bundleId: z.string().trim().min(1),
  profiles: z.array(signingProfileCandidateSchema),
  warnings: z.array(signingDiscoveryWarningSchema),
}).strict()

export function parseSigningDiscovery(value: unknown): SigningDiscoveryResult {
  return signingDiscoverySchema.parse(value)
}

const signingProfileImportSchema = signingDiscoverySchema.extend({
  importedProfileUuid: z.string().trim().min(1),
}).strict()

export function parseSigningProfileImport(value: unknown): SigningProfileImportResult {
  return signingProfileImportSchema.parse(value)
}

const absolutePathSchema = z.string().min(1).refine((value) => value.startsWith('/'), 'Expected an absolute path')
const repositoryWarningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  rootPath: absolutePathSchema.optional(),
}).strict()
const repositoryCandidateSchema = z.object({
  path: absolutePathSchema,
  name: z.string().trim().min(1),
  rootPath: absolutePathSchema,
  relativePath: z.string().trim(),
  displayLabel: z.string().trim().min(1),
  hasGit: z.boolean(),
}).strict()
const repositoryDiscoverySchema = z.object({
  repositories: z.array(repositoryCandidateSchema),
  warnings: z.array(repositoryWarningSchema),
  truncated: z.boolean(),
}).strict()
const repositoryChoiceSchema = z.object({ repository: repositoryCandidateSchema }).strict()

export function parseRepositoryDiscovery(value: unknown): RepositoryDiscoveryResult {
  return repositoryDiscoverySchema.parse(value)
}

export function parseRepositoryChoice(value: unknown): RepositoryCandidate {
  return repositoryChoiceSchema.parse(value).repository
}

export function parseProjectValidation(value: unknown): ProjectValidation {
  const raw = object(unwrap(value, ['validation', 'data']))
  return {
    valid: booleanValue(raw.valid),
    message: optionalString(raw.message),
    canonicalRepoPath: optionalString(raw.canonicalRepoPath),
    missingEnvironmentVariables: Array.isArray(raw.missingEnvironmentVariables) ? raw.missingEnvironmentVariables.map(String) : undefined,
  }
}

export function parseProjectSetup(value: unknown): ProjectSetupResult {
  const raw = object(value)
  const setup = object(raw.setup)
  return {
    dependenciesInstalled: booleanValue(setup.dependenciesInstalled),
    validation: parseProjectValidation(raw.validation),
    project: parseProject(raw.project),
  }
}

export function parseUser(value: unknown): User {
  const raw = object(unwrap(value, ['user', 'data']))
  const keys = raw.projectKeys ?? raw.project_keys ?? raw.projectPermissions
  return {
    id: stringValue(raw.id),
    displayName: stringValue(raw.displayName ?? raw.display_name ?? raw.name, stringValue(raw.id)),
    enabled: booleanValue(raw.enabled ?? raw.active, true),
    projectKeys: Array.isArray(keys) ? keys.map(String) : [],
    createdAt: optionalString(raw.createdAt ?? raw.created_at),
    updatedAt: optionalString(raw.updatedAt ?? raw.updated_at),
  }
}

export function parseUsers(value: unknown): User[] {
  return z.array(z.unknown()).parse(unwrap(value, ['users', 'items', 'data'])).map(parseUser)
}

const buildStatuses = new Set(['enqueueing', 'queued', 'running', 'success', 'failed'])
export function parseBuild(value: unknown): Build {
  const raw = object(unwrap(value, ['build', 'data']))
  const status = stringValue(raw.status).toLowerCase()
  const startedAt = optionalString(raw.startedAt ?? raw.started_at)
  const finishedAt = optionalString(raw.finishedAt ?? raw.finished_at)
  const derivedDuration = startedAt && finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : undefined
  return {
    id: stringValue(raw.id ?? raw.buildId ?? raw.build_id),
    projectKey: stringValue(raw.projectKey ?? raw.project_key),
    projectName: optionalString(raw.projectName ?? raw.project_name),
    appVersion: optionalString(raw.appVersion ?? raw.app_version),
    requestedScheme: optionalString(raw.requestedScheme ?? raw.requested_scheme),
    buildNumber: stringValue(raw.buildNumber ?? raw.build_number),
    releaseNotes: optionalString(raw.releaseNotes ?? raw.release_notes),
    source: stringValue(raw.source, 'cms') === 'lark' ? 'lark' : 'cms',
    status: buildStatuses.has(status) ? status as Build['status'] : 'unknown',
    requestedBy: optionalString(raw.requestedBy ?? raw.requested_by),
    attemptCount: numberValue(raw.attemptCount ?? raw.attempt_count, 0),
    retryOfId: optionalString(raw.retryOfId ?? raw.retry_of_id),
    failurePhase: optionalString(raw.failurePhase ?? raw.failure_phase),
    createdAt: stringValue(raw.createdAt ?? raw.created_at, new Date(0).toISOString()),
    queuedAt: optionalString(raw.queuedAt ?? raw.queued_at),
    startedAt,
    finishedAt,
    durationMs: raw.durationMs != null ? numberValue(raw.durationMs) : derivedDuration,
    errorMessage: optionalString(raw.errorMessage ?? raw.error_message),
    artifactUrl: optionalString(raw.artifactUrl ?? raw.artifact_url),
  }
}

export function parseBuildDetail(value: unknown): BuildDetail {
  const raw = object(unwrap(value, ['build', 'data']))
  return { ...parseBuild(raw), configSnapshot: raw.configSnapshot && typeof raw.configSnapshot === 'object' ? recordSchema.parse(raw.configSnapshot) : undefined }
}

export function parseBuilds(value: unknown): BuildListResult {
  const raw = Array.isArray(value) ? {} : object(value)
  const list = Array.isArray(value) ? value : raw.builds ?? raw.items ?? []
  return {
    items: z.array(z.unknown()).parse(list).map(parseBuild),
    nextCursor: optionalString(raw.nextCursor ?? raw.next_cursor) ?? null,
  }
}

export function parseDashboard(value: unknown): DashboardData {
  const raw = object(unwrap(value, ['dashboard', 'data']))
  const projects = raw.projects && typeof raw.projects === 'object' ? object(raw.projects) : {}
  const builds = raw.builds && typeof raw.builds === 'object' ? object(raw.builds) : {}
  const runner = raw.runner && typeof raw.runner === 'object' ? object(raw.runner) : {}
  const succeeded = numberValue(builds.success ?? builds.succeeded)
  const failed = numberValue(builds.failed)
  const completed = succeeded + failed
  return {
    projectsTotal: numberValue(projects.total),
    projectsEnabled: numberValue(projects.enabled),
    buildsActive: numberValue(builds.running),
    buildsQueued: numberValue(builds.queued),
    buildsSucceeded: succeeded,
    buildsFailed: failed,
    last24HoursSucceeded: numberValue(builds.last24HoursSuccess),
    last24HoursFailed: numberValue(builds.last24HoursFailed),
    successRate: completed ? Math.round((succeeded / completed) * 100) : null,
    recentBuilds: z.array(z.unknown()).parse(builds.recentBuilds ?? []).map(parseBuild),
    runnerOnline: booleanValue(runner.online),
  }
}
