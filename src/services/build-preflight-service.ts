import type { ProjectConfigSnapshot } from '../domain/project';
import type { ProjectRepository } from '../repositories/project-repository';
import type { ProjectConfigService } from './project-config-service';
import { git, lockRepository } from './repository-operations-service';

export function createBuildPreflight(projects: ProjectRepository, configService: ProjectConfigService) {
  return async (config: ProjectConfigSnapshot): Promise<() => Promise<void>> => {
    const unlock = await lockRepository(config.repoPath);
    try {
      const project = projects.findByKey(config.projectKey);
      if (!project || !project.enabled || project.version !== config.projectVersion) {
        throw new Error('Project changed or was disabled; submit a new build');
      }
      const result = await configService.validate({ ...project, scheme: config.scheme });
      const recorded = projects.setValidation(project.projectKey, result.valid ? 'valid' : 'invalid', result.message, project.version);
      if (!recorded) throw new Error('Project changed during pre-build validation; submit a new build');
      if (!result.valid) throw new Error(`Pre-build validation failed: ${result.message}`);
      if (config.gitCommit && await git(config.repoPath, ['rev-parse', 'HEAD']) !== config.gitCommit) {
        throw new Error('Repository commit changed; submit a new build');
      }
      return unlock;
    } catch (error) { await unlock(); throw error; }
  };
}
