import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { Project, ProjectConfigSnapshot } from '../domain/project';
import { AppError } from '../http/errors';
import { ProjectRepository } from '../repositories/project-repository';

const execFileAsync = promisify(execFile);
const envReferencePattern = /^[A-Z][A-Z0-9_]*$/;
const bundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const envReference = z.string().regex(envReferencePattern);
const bundleEnvironmentKeys = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'GEM_HOME', 'GEM_PATH', 'RUBYOPT', 'RBENV_ROOT',
];

function createBundleEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    bundleEnvironmentKeys.flatMap((key) => environment[key] ? [[key, environment[key]]] : []),
  );
}

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

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class ProjectConfigService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly allowedRepoRoots: string[],
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

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

  async validate(project: Project): Promise<ProjectValidationResult> {
    const parsed = projectConfigSchema.safeParse(project);
    if (!parsed.success) {
      return {
        valid: false,
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      };
    }

    if (this.allowedRepoRoots.length === 0) {
      return { valid: false, message: 'IOS_REPO_ROOTS is not configured' };
    }

    try {
      const canonicalRepoPath = await fs.realpath(project.repoPath);
      const rootResults = await Promise.all(
        this.allowedRepoRoots.map(async (root) => {
          try {
            return await fs.realpath(root);
          } catch {
            return null;
          }
        }),
      );
      const insideAllowedRoot = rootResults.some((root) => root && isPathInside(root, canonicalRepoPath));

      if (!insideAllowedRoot) {
        return { valid: false, message: 'Repository path is outside IOS_REPO_ROOTS' };
      }

      const stat = await fs.stat(canonicalRepoPath);
      if (!stat.isDirectory()) {
        return { valid: false, message: 'Repository path is not a directory' };
      }

      await Promise.all([
        fs.access(path.join(canonicalRepoPath, 'Gemfile')),
        fs.access(path.join(canonicalRepoPath, 'fastlane', 'Fastfile')),
      ]);

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

      await execFileAsync(this.environment.BUNDLE_BIN?.trim() || 'bundle', ['check'], {
        cwd: canonicalRepoPath,
        env: createBundleEnvironment(this.environment),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });

      return { valid: true, message: 'Project configuration is valid', canonicalRepoPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, message: `Project validation failed: ${message.slice(0, 500)}` };
    }
  }
}
