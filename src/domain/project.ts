export type ProjectValidationStatus = 'unknown' | 'valid' | 'invalid';
export type SigningMode = 'manual' | 'match';

export interface ProvisioningProfileMapping {
  bundleId: string;
  profileName: string;
  profileUuid?: string;
}

export interface ProjectRow {
  project_key: string;
  display_name: string;
  repo_path: string;
  fastlane_lane: string;
  scheme: string | null;
  build_configuration: string | null;
  firebase_app_id: string;
  firebase_tester_groups_json: string;
  firebase_cli_token_env_var: string;
  match_password_env_var: string | null;
  app_store_connect_key_id_env_var: string | null;
  app_store_connect_issuer_id_env_var: string | null;
  app_store_connect_key_path_env_var: string | null;
  signing_mode: SigningMode;
  apple_team_id: string | null;
  signing_certificate: string;
  provisioning_profiles_json: string;
  lark_notification_chat_id: string | null;
  enabled: number;
  version: number;
  validation_status: ProjectValidationStatus;
  validation_message: string | null;
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  projectKey: string;
  displayName: string;
  repoPath: string;
  fastlaneLane: string;
  scheme?: string | null;
  buildConfiguration?: string | null;
  firebaseAppId: string;
  firebaseTesterGroups: string[];
  firebaseCliTokenEnvVar: string;
  matchPasswordEnvVar?: string | null;
  appStoreConnectKeyIdEnvVar?: string | null;
  appStoreConnectIssuerIdEnvVar?: string | null;
  appStoreConnectKeyPathEnvVar?: string | null;
  signingMode?: SigningMode;
  appleTeamId?: string | null;
  signingCertificate?: string;
  provisioningProfiles?: ProvisioningProfileMapping[];
  larkNotificationChatId?: string | null;
  enabled?: boolean;
}

export interface ProjectUpdateInput extends Omit<ProjectInput, 'projectKey'> {
  version: number;
}

export interface Project extends ProjectInput {
  signingMode: SigningMode;
  appleTeamId: string | null;
  signingCertificate: string;
  provisioningProfiles: ProvisioningProfileMapping[];
  larkNotificationChatId: string | null;
  enabled: boolean;
  version: number;
  validationStatus: ProjectValidationStatus;
  validationMessage: string | null;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfigSnapshotV1 {
  schemaVersion: 1;
  projectKey: string;
  displayName: string;
  repoPath: string;
  fastlaneLane: string;
  scheme?: string | null;
  buildConfiguration?: string | null;
  firebaseAppId: string;
  firebaseTesterGroups: string[];
  secretEnvRefs: {
    firebaseCliToken: string;
    matchPassword?: string | null;
    appStoreConnectKeyId?: string | null;
    appStoreConnectIssuerId?: string | null;
    appStoreConnectKeyPath?: string | null;
  };
  projectVersion: number;
}

export interface ProjectConfigSnapshotV2 {
  schemaVersion: 2;
  projectKey: string;
  displayName: string;
  repoPath: string;
  fastlaneLane: string;
  scheme?: string | null;
  buildConfiguration?: string | null;
  firebaseAppId: string;
  firebaseTesterGroups: string[];
  signingMode: SigningMode;
  appleTeamId: string | null;
  signingCertificate: string;
  provisioningProfiles: ProvisioningProfileMapping[];
  larkNotificationChatId?: string | null;
  secretEnvRefs: {
    firebaseCliToken: string;
    matchPassword?: string | null;
    appStoreConnectKeyId?: string | null;
    appStoreConnectIssuerId?: string | null;
    appStoreConnectKeyPath?: string | null;
  };
  projectVersion: number;
}

export type ProjectConfigSnapshot = ProjectConfigSnapshotV1 | ProjectConfigSnapshotV2;
