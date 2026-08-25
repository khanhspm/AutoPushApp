export interface RepositoryCandidate {
  path: string;
  name: string;
  rootPath: string;
  relativePath: string;
  displayLabel: string;
  hasGit: boolean;
}

export type RepositoryDiscoveryWarningCode =
  | 'REPOSITORY_ROOTS_NOT_CONFIGURED'
  | 'REPOSITORY_ROOT_UNAVAILABLE'
  | 'REPOSITORY_DIRECTORY_UNREADABLE'
  | 'REPOSITORY_SCAN_TRUNCATED';

export interface RepositoryDiscoveryWarning {
  code: RepositoryDiscoveryWarningCode;
  message: string;
}

export interface RepositoryDiscoveryResult {
  repositories: RepositoryCandidate[];
  warnings: RepositoryDiscoveryWarning[];
  truncated: boolean;
}
