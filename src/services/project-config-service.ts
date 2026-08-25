import { z } from 'zod';

import type { Project, ProjectConfigSnapshot } from '../domain/project';
import { AppError } from '../http/errors';
import { ProjectRepository } from '../repositories/project-repository';
import { BundlerService, type BundlerGateway } from './bundler-service';
import type { RepositoryCandidateResolver } from './repository-discovery-service';

const envReferencePattern = /^[A-Z][A-Z0-9_]*$/;
const bundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const profileUuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const envReference = z.string().regex(envReferencePattern);

const projectConfigSchema = z
  .object({
    projectKey: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/),
    displayName: z.string().trim().min(1).max(120),
    fastlaneLane: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/),
    scheme: z.string().trim().max(120).regex(/^[A-Za-z0-9_. -]*$/).nullable().optional(),
    buildConfiguration: z.string().trim().max(80).regex(/^[A-Za-z0-9_. -]*$/).nullable().optional(),
    firebaseAppId: z.string().trim().min(1).max(200),
    firebaseTesterGroups: z.array(z.string().trim().min(1).max(120)).min(1),
    firebaseCliTokenEnvVar: envReference,
    matchPasswordEnvVar: z.string().trim().max(120).nullable().optional(),
    appStoreConnectKeyIdEnvVar: z.string().trim().max(120).nullable().optional(),
    appStoreConnectIssuerIdEnvVar: z.string().trim().max(120).nullable().optional(),
    appStoreConnectKeyPathEnvVar: z.string().trim().max(120).nullable().optional(),
    signingMode: z.enum(['manual', 'match']),
    appleTeamId: z.string().trim().max(120).nullable(),
    signingCertificate: z.string().trim().max(200),
    provisioningProfiles: z
      .array(
        z.object({
          bundleId: z.string().trim().max(255),
          profileName: z.string().trim().max(255),
          profileUuid: z.string().trim().regex(profileUuidPattern).optional(),
        }),
      )
      .max(50),
    larkNotificationChatId: z.string().trim().max(200).regex(/^oc_[A-Za-z0-9_-]+$/).nullable().optional(),
  })
  .superRefine((project, context) => {
    if (project.signingMode === 'match') {
      const requiredReferences = [
        ['matchPasswordEnvVar', project.matchPasswordEnvVar],
        ['appStoreConnectKeyIdEnvVar', project.appStoreConnectKeyIdEnvVar],
        ['appStoreConnectIssuerIdEnvVar', project.appStoreConnectIssuerIdEnvVar],
        ['appStoreConnectKeyPathEnvVar', project.appStoreConnectKeyPathEnvVar],
      ] as const;

      for (const [field, value] of requiredReferences) {
        if (!value) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for Match signing` });
        } else if (!envReferencePattern.test(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} must be an uppercase environment variable name`,
          });
        }
      }
      return;
    }

    if (!project.appleTeamId || !/^[A-Z0-9]{10}$/.test(project.appleTeamId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appleTeamId'],
        message: 'Apple team ID must contain 10 uppercase letters or numbers',
      });
    }
    if (!project.signingCertificate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signingCertificate'],
        message: 'Signing certificate is required for manual signing',
      });
    }
    if (project.provisioningProfiles.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provisioningProfiles'],
        message: 'Add at least one provisioning profile mapping for manual signing',
      });
    }

    const seen = new Set<string>();
    for (const [index, profile] of project.provisioningProfiles.entries()) {
      if (!bundleIdPattern.test(profile.bundleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provisioningProfiles', index, 'bundleId'],
          message: 'Use a concrete bundle identifier without wildcards',
        });
      }
      if (!profile.profileName) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provisioningProfiles', index, 'profileName'],
          message: 'Profile name is required',
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
  });

export interface ProjectValidationResult {
  valid: boolean;
  message: string;
  canonicalRepoPath?: string;
  missingEnvironmentVariables?: string[];
}

export interface ProjectValidationOptions {
  canonicalRepoPath?: string;
  dependenciesSatisfied?: boolean;
}

export class ProjectConfigService {
  private readonly bundler: BundlerGateway;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly repositoryDiscovery: RepositoryCandidateResolver,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    bundler?: BundlerGateway,
  ) {
    this.bundler = bundler ?? new BundlerService(environment);
  }

  async validateAndRecord(projectKey: string): Promise<ProjectValidationResult> {
    const project = this.projects.findByKey(projectKey);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${projectKey} was not found`);
    }

    const result = await this.validate(project);
    const recorded = this.projects.setValidation(
      projectKey,
      result.valid ? 'valid' : 'invalid',
      result.message,
      project.version,
    );
    if (!recorded) {
      throw new AppError(409, 'PROJECT_VERSION_CONFLICT', 'Project changed while validation was running');
    }
    return result;
  }

  async resolveForBuild(projectKey: string): Promise<ProjectConfigSnapshot> {
    const project = this.projects.findByKey(projectKey);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${projectKey} was not found`);
    }
    if (!project.enabled) {
      throw new AppError(409, 'PROJECT_DISABLED', `Project ${projectKey} is disabled`);
    }

    const result = await this.validate(project);
    const recorded = this.projects.setValidation(
      projectKey,
      result.valid ? 'valid' : 'invalid',
      result.message,
      project.version,
    );
    if (!recorded) {
      throw new AppError(409, 'PROJECT_VERSION_CONFLICT', 'Project changed while validation was running');
    }

    if (!result.valid || !result.canonicalRepoPath) {
      throw new AppError(409, 'PROJECT_CONFIG_INVALID', result.message);
    }

    return {
      ...this.projects.toSnapshot(project),
      repoPath: result.canonicalRepoPath,
    };
  }

  async validate(project: Project, options: ProjectValidationOptions = {}): Promise<ProjectValidationResult> {
    const parsed = projectConfigSchema.safeParse(project);
    if (!parsed.success) {
      return {
        valid: false,
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      };
    }

    if (this.repositoryDiscovery.hasConfiguredRoots?.() === false) {
      return { valid: false, message: 'IOS_REPO_ROOTS is not configured' };
    }

    let canonicalRepoPath = options.canonicalRepoPath;
    if (!canonicalRepoPath) {
      try {
        canonicalRepoPath = (await this.repositoryDiscovery.resolveCandidate(project.repoPath)).path;
      } catch (error) {
        const message = error instanceof AppError
          ? error.fields?.repoPath?.[0] ?? error.message
          : 'Repository could not be resolved';
        return { valid: false, message };
      }
    }

    const references = project.signingMode === 'match'
      ? [
          project.firebaseCliTokenEnvVar,
          project.matchPasswordEnvVar,
          project.appStoreConnectKeyIdEnvVar,
          project.appStoreConnectIssuerIdEnvVar,
          project.appStoreConnectKeyPathEnvVar,
        ]
      : [project.firebaseCliTokenEnvVar];
    const missingEnvironmentVariables = references
      .filter((value): value is string => Boolean(value))
      .filter((name) => !this.environment[name]?.trim());

    if (missingEnvironmentVariables.length > 0) {
      return {
        valid: false,
        message: `Missing runner environment variables: ${missingEnvironmentVariables.join(', ')}`,
        canonicalRepoPath,
        missingEnvironmentVariables,
      };
    }

    const dependenciesSatisfied = options.dependenciesSatisfied ?? await this.bundler.check(canonicalRepoPath);
    if (!dependenciesSatisfied) {
      return {
        valid: false,
        message: 'Project dependencies are not installed. Run Setup & Validate.',
        canonicalRepoPath,
      };
    }

    return { valid: true, message: 'Project configuration is valid', canonicalRepoPath };
  }
}
