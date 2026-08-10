import { z } from 'zod'

const optionalText = z.string().trim().optional().transform((value) => value || undefined)
const envReference = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'Use an uppercase environment variable name')
const optionalEnvReference = z.string().trim().max(120).optional().transform((value) => value || undefined)
const optionalLarkChatId = z.string().trim().max(200).optional().refine(
  (value) => !value || /^oc_[A-Za-z0-9_-]+$/.test(value),
  'Use a Lark group chat ID beginning with oc_',
).transform((value) => value || undefined)
const bundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/

export const projectFormSchema = z.object({
  projectKey: z.string().trim().min(1, 'Project key is required').max(80).regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, numbers, dots, hyphens, or underscores'),
  displayName: z.string().trim().min(1, 'Display name is required').max(120),
  repoPath: z.string().trim().min(1, 'Repository path is required').max(1000),
  fastlaneLane: z.string().trim().min(1, 'Fastlane lane is required').max(80).regex(/^[A-Za-z0-9_.-]+$/, 'Use a valid Fastlane lane name'),
  scheme: optionalText,
  buildConfiguration: optionalText,
  firebaseAppId: z.string().trim().min(1, 'Firebase app ID is required').max(200),
  firebaseTesterGroupsText: z.string().trim().min(1, 'Add at least one Firebase tester group'),
  firebaseCliTokenEnvVar: envReference,
  matchPasswordEnvVar: optionalEnvReference,
  appStoreConnectKeyIdEnvVar: optionalEnvReference,
  appStoreConnectIssuerIdEnvVar: optionalEnvReference,
  appStoreConnectKeyPathEnvVar: optionalEnvReference,
  signingMode: z.enum(['manual', 'match']),
  appleTeamId: optionalText,
  signingCertificate: z.string().trim().max(200),
  provisioningProfiles: z.array(z.object({
    bundleId: z.string().trim().max(255),
    profileName: z.string().trim().max(255),
  })).max(50),
  larkNotificationChatId: optionalLarkChatId,
  enabled: z.boolean(),
  version: z.number().int().positive().optional(),
}).superRefine((project, context) => {
  if (project.signingMode === 'match') {
    if (!project.enabled) return
    const requiredReferences = [
      ['matchPasswordEnvVar', project.matchPasswordEnvVar],
      ['appStoreConnectKeyIdEnvVar', project.appStoreConnectKeyIdEnvVar],
      ['appStoreConnectIssuerIdEnvVar', project.appStoreConnectIssuerIdEnvVar],
      ['appStoreConnectKeyPathEnvVar', project.appStoreConnectKeyPathEnvVar],
    ] as const
    for (const [field, value] of requiredReferences) {
      if (!value) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Required for Match signing' })
      else if (!/^[A-Z][A-Z0-9_]*$/.test(value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Use an uppercase environment variable name' })
    }
    return
  }

  if (project.appleTeamId && !/^[A-Z0-9]{10}$/.test(project.appleTeamId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['appleTeamId'], message: 'Use the 10-character Apple Team ID' })
  }

  const seen = new Set<string>()
  project.provisioningProfiles.forEach((profile, index) => {
    if (profile.bundleId && !bundleIdPattern.test(profile.bundleId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['provisioningProfiles', index, 'bundleId'], message: 'Use a concrete bundle ID without wildcards' })
    }
    const key = profile.bundleId.toLowerCase()
    if (key && seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['provisioningProfiles', index, 'bundleId'], message: 'Bundle IDs must be unique' })
    }
    if (key) seen.add(key)
  })

  if (!project.enabled) return
  if (!project.appleTeamId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['appleTeamId'], message: 'Use the 10-character Apple Team ID' })
  }
  if (!project.signingCertificate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['signingCertificate'], message: 'Signing certificate is required' })
  }
  if (project.provisioningProfiles.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['provisioningProfiles'], message: 'Add at least one profile mapping' })
  }
  project.provisioningProfiles.forEach((profile, index) => {
    if (!profile.bundleId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['provisioningProfiles', index, 'bundleId'], message: 'Bundle ID is required' })
    }
    if (!profile.profileName) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['provisioningProfiles', index, 'profileName'], message: 'Profile name is required' })
    }
  })
})

export const userFormSchema = z.object({
  id: z.string().trim().min(1, 'User ID is required').max(200),
  displayName: z.string().trim().min(1, 'Display name is required').max(120),
  enabled: z.boolean(),
})

export const buildTriggerSchema = z.object({
  appVersion: z.string().trim().min(1, 'App version is required').max(40).regex(/^\d+(?:\.\d+){0,2}$/, 'Use a version like 1.1 or 1.1.0'),
  scheme: z.string().trim().min(1, 'Scheme is required').max(120).regex(/^[A-Za-z0-9_. -]+$/, 'Use a valid Xcode scheme name'),
  buildNumber: z.string().trim().min(1, 'Build number is required').max(80),
  releaseNotes: z.string().max(10_000).optional().default(''),
})

export type ProjectFormValues = z.infer<typeof projectFormSchema>
export type UserFormValues = z.infer<typeof userFormSchema>
export type BuildTriggerValues = z.infer<typeof buildTriggerSchema>

export function parseTesterGroups(value: string): string[] {
  return [...new Set(value.split(',').map((group) => group.trim()).filter(Boolean))]
}

export function firstZodError(error: z.ZodError): Record<string, string> {
  return error.issues.reduce<Record<string, string>>((errors, issue) => {
    const field = issue.path.length ? issue.path.join('.') : 'form'
    if (!errors[field]) errors[field] = issue.message
    return errors
  }, {})
}
