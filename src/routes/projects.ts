import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../app-context';
import type { Project, ProjectInput, ProjectUpdateInput } from '../domain/project';
import { AppError } from '../http/errors';

const nullableText = z.preprocess((value) => (value === '' ? null : value), z.string().trim().nullable().optional());
const envReferenceSchema = z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/, 'Use an uppercase environment variable name');
const nullableEnvReference = z.preprocess((value) => (value === '' ? null : value), envReferenceSchema.nullable().optional());
const nullableLarkChatId = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().trim().max(200).regex(/^oc_[A-Za-z0-9_-]+$/, 'Use a Lark group chat ID beginning with oc_').nullable().optional(),
);
const projectKeySchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/);
const profileUuidSchema = z.string().trim().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
const bundleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, 'Use a concrete bundle identifier without wildcards');
const provisioningProfileSchema = z.object({
  bundleId: z.string().trim().max(255),
  profileName: z.string().trim().max(255),
  profileUuid: profileUuidSchema.optional(),
});

const projectShape = {
  projectKey: projectKeySchema,
  displayName: z.string().trim().min(1).max(120),
  repoPath: z.string().max(1000).refine((value) => value.trim().length > 0),
  fastlaneLane: z.string().trim().min(1).max(80),
  scheme: nullableText,
  buildConfiguration: nullableText,
  firebaseAppId: z.string().trim().min(1).max(200),
  firebaseTesterGroups: z.array(z.string().trim().min(1).max(120)).min(1),
  firebaseCliTokenEnvVar: envReferenceSchema,
  matchPasswordEnvVar: nullableEnvReference,
  appStoreConnectKeyIdEnvVar: nullableEnvReference,
  appStoreConnectIssuerIdEnvVar: nullableEnvReference,
  appStoreConnectKeyPathEnvVar: nullableEnvReference,
  signingMode: z.enum(['manual', 'match']).optional(),
  appleTeamId: z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(120).nullable().optional(),
  ),
  signingCertificate: z.string().trim().max(200).optional(),
  provisioningProfiles: z.array(provisioningProfileSchema).max(50).optional(),
  larkNotificationChatId: nullableLarkChatId,
  enabled: z.boolean().optional().default(false),
};

function validateManualSigning(
  value: {
    signingMode?: 'manual' | 'match';
    appleTeamId?: string | null;
    signingCertificate?: string;
    provisioningProfiles?: Array<{ bundleId: string; profileName: string; profileUuid?: string }>;
  },
  context: z.RefinementCtx,
): void {
  if (value.signingMode !== 'manual') return;

  if (value.appleTeamId && !/^[A-Z0-9]{10}$/.test(value.appleTeamId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['appleTeamId'],
      message: 'Apple team ID must contain 10 uppercase letters or numbers',
    });
  }

  const profiles = value.provisioningProfiles ?? [];
  const seen = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    if (profile.bundleId && !bundleIdSchema.safeParse(profile.bundleId).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provisioningProfiles', index, 'bundleId'],
        message: 'Use a concrete bundle identifier without wildcards',
      });
    }

    const key = profile.bundleId.toLowerCase();
    if (key && seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provisioningProfiles', index, 'bundleId'],
        message: 'Bundle IDs must be unique',
      });
    }
    if (key) seen.add(key);
  }
}

const projectBodySchema = z.object(projectShape).superRefine(validateManualSigning);
const { projectKey: _projectKey, ...projectUpdateShape } = projectShape;
const projectUpdateSchema = z
  .object({ ...projectUpdateShape, version: z.number().int().positive() })
  .superRefine(validateManualSigning);
const buildBodySchema = z.object({
  appVersion: z.string().trim().max(40).optional(),
  scheme: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_. -]+$/),
  buildNumber: z.string().trim().min(1).max(80),
  releaseNotes: z.string().max(10_000).optional().default(''),
});

function applySigningDefaults<T extends ProjectInput | ProjectUpdateInput>(input: T, current?: Project): T {
  const provisioningProfiles = (input.provisioningProfiles ?? current?.provisioningProfiles ?? []).map((profile) => {
    if (profile.profileUuid || !current) return profile;
    const existing = current.provisioningProfiles.find((candidate) => (
      candidate.bundleId === profile.bundleId && candidate.profileName === profile.profileName
    ));
    return existing?.profileUuid ? { ...profile, profileUuid: existing.profileUuid } : profile;
  });
  return {
    ...input,
    signingMode: input.signingMode ?? current?.signingMode ?? 'match',
    appleTeamId: input.appleTeamId === undefined ? (current?.appleTeamId ?? null) : input.appleTeamId,
    signingCertificate: input.signingCertificate ?? current?.signingCertificate ?? 'Apple Distribution',
    provisioningProfiles,
    larkNotificationChatId: input.larkNotificationChatId === undefined
      ? (current?.larkNotificationChatId ?? null)
      : input.larkNotificationChatId,
  };
}

function idempotencyHeader(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
  }
  return `cms:${key}`;
}

export function projectRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => ({ projects: context.projects.list() }));

    app.post('/', async (request, reply) => {
      const parsedInput = applySigningDefaults(projectBodySchema.parse(request.body));
      const repository = await context.repositoryDiscovery.resolveCandidate(parsedInput.repoPath);
      const input = { ...parsedInput, repoPath: repository.path };
      let project = context.projects.create(input);
      let validation = null;

      if (input.enabled) {
        validation = await context.projectConfig.validateAndRecord(project.projectKey);
        if (validation.valid) {
          project = context.projects.setEnabled(project.projectKey, true)!;
        } else {
          project = context.projects.findByKey(project.projectKey)!;
        }
      }

      return reply.code(201).send({ project, validation });
    });

    app.get('/:projectKey', async (request) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      const project = context.projects.findByKey(projectKey);
      if (!project) {
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
      }

      return {
        project,
        builds: context.builds.list({ projectKey, limit: 20 }).builds,
      };
    });

    app.put('/:projectKey', async (request) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      const current = context.projects.findByKey(projectKey);
      if (!current) {
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
      }

      const parsedInput = applySigningDefaults(projectUpdateSchema.parse(request.body), current);
      const keepUnresolvedLegacyPath = !parsedInput.enabled && parsedInput.repoPath === current.repoPath;
      const input = keepUnresolvedLegacyPath
        ? { ...parsedInput, repoPath: current.repoPath }
        : {
            ...parsedInput,
            repoPath: (await context.repositoryDiscovery.resolveCandidate(parsedInput.repoPath)).path,
          };
      let project = context.projects.update(projectKey, input);
      if (!project) {
        if (!context.projects.findByKey(projectKey)) {
          throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
        }
        throw new AppError(409, 'PROJECT_VERSION_CONFLICT', 'Project was changed by another administrator');
      }

      let validation = null;
      if (input.enabled) {
        validation = await context.projectConfig.validateAndRecord(projectKey);
        if (validation.valid) {
          project = context.projects.setEnabled(projectKey, true)!;
        } else {
          project = context.projects.findByKey(projectKey)!;
        }
      }

      return { project, validation };
    });

    app.delete('/:projectKey', async (request, reply) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      const exists = context.projects.findByKey(projectKey);
      if (!exists) {
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
      }
      if (!context.projects.delete(projectKey)) {
        throw new AppError(409, 'PROJECT_HAS_ACTIVE_BUILDS', 'Disable the project and wait for active builds to finish');
      }
      return reply.code(204).send();
    });

    app.post('/:projectKey/validate', async (request) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      const validation = await context.projectConfig.validateAndRecord(projectKey);
      return { validation, project: context.projects.findByKey(projectKey) };
    });

    app.post('/:projectKey/setup-and-validate', async (request) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      z.undefined().parse(request.body);
      const result = await context.projectSetup.setupAndValidate(projectKey);
      return {
        setup: { dependenciesInstalled: result.dependenciesInstalled },
        validation: result.validation,
        project: result.project,
      };
    });

    app.post('/:projectKey/builds', async (request, reply) => {
      const projectKey = projectKeySchema.parse((request.params as { projectKey: string }).projectKey);
      const input = buildBodySchema.parse(request.body);
      const result = await context.buildRequests.submit({
        projectKey,
        appVersion: input.appVersion,
        scheme: input.scheme,
        buildNumber: input.buildNumber,
        releaseNotes: input.releaseNotes,
        source: 'cms',
        requestedBy: 'cms-admin',
        idempotencyKey: idempotencyHeader(request.headers),
      });
      return reply.code(result.created ? 202 : 200).send(result);
    });
  };
}
