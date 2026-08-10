import type { AppDatabase } from '../db/database';
import type {
  Project,
  ProjectConfigSnapshotV2,
  ProjectInput,
  ProjectRow,
  ProjectUpdateInput,
  ProjectValidationStatus,
  ProvisioningProfileMapping,
} from '../domain/project';

function normalizeGroups(groups: string[]): string[] {
  return [...new Set(groups.map((group) => group.trim()).filter(Boolean))];
}

function normalizeProvisioningProfiles(profiles: ProvisioningProfileMapping[] = []): ProvisioningProfileMapping[] {
  return profiles.map((profile) => ({
    bundleId: profile.bundleId.trim(),
    profileName: profile.profileName.trim(),
  }));
}

function mapProject(row: ProjectRow): Project {
  return {
    projectKey: row.project_key,
    displayName: row.display_name,
    repoPath: row.repo_path,
    fastlaneLane: row.fastlane_lane,
    scheme: row.scheme,
    buildConfiguration: row.build_configuration,
    firebaseAppId: row.firebase_app_id,
    firebaseTesterGroups: JSON.parse(row.firebase_tester_groups_json) as string[],
    firebaseCliTokenEnvVar: row.firebase_cli_token_env_var,
    matchPasswordEnvVar: row.match_password_env_var,
    appStoreConnectKeyIdEnvVar: row.app_store_connect_key_id_env_var,
    appStoreConnectIssuerIdEnvVar: row.app_store_connect_issuer_id_env_var,
    appStoreConnectKeyPathEnvVar: row.app_store_connect_key_path_env_var,
    signingMode: row.signing_mode,
    appleTeamId: row.apple_team_id,
    signingCertificate: row.signing_certificate,
    provisioningProfiles: JSON.parse(row.provisioning_profiles_json) as ProvisioningProfileMapping[],
    larkNotificationChatId: row.lark_notification_chat_id,
    enabled: row.enabled === 1,
    version: row.version,
    validationStatus: row.validation_status,
    validationMessage: row.validation_message,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): Project[] {
    return (this.database
      .prepare('SELECT * FROM projects ORDER BY display_name COLLATE NOCASE, project_key COLLATE NOCASE')
      .all() as ProjectRow[]).map(mapProject);
  }

  findByKey(projectKey: string): Project | null {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE project_key = ? COLLATE NOCASE')
      .get(projectKey) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  create(input: ProjectInput): Project {
    this.database
      .prepare(`
        INSERT INTO projects (
          project_key, display_name, repo_path, fastlane_lane, scheme, build_configuration,
          firebase_app_id, firebase_tester_groups_json, firebase_cli_token_env_var,
          match_password_env_var, app_store_connect_key_id_env_var,
          app_store_connect_issuer_id_env_var, app_store_connect_key_path_env_var,
          signing_mode, apple_team_id, signing_certificate, provisioning_profiles_json,
          lark_notification_chat_id, enabled
        ) VALUES (
          @projectKey, @displayName, @repoPath, @fastlaneLane, @scheme, @buildConfiguration,
          @firebaseAppId, @firebaseTesterGroupsJson, @firebaseCliTokenEnvVar,
          @matchPasswordEnvVar, @appStoreConnectKeyIdEnvVar,
          @appStoreConnectIssuerIdEnvVar, @appStoreConnectKeyPathEnvVar,
          @signingMode, @appleTeamId, @signingCertificate, @provisioningProfilesJson,
          @larkNotificationChatId, 0
        )
      `)
      .run({
        ...input,
        scheme: input.scheme ?? null,
        buildConfiguration: input.buildConfiguration === undefined ? 'Debug' : input.buildConfiguration,
        firebaseTesterGroupsJson: JSON.stringify(normalizeGroups(input.firebaseTesterGroups)),
        matchPasswordEnvVar: input.matchPasswordEnvVar ?? null,
        appStoreConnectKeyIdEnvVar: input.appStoreConnectKeyIdEnvVar ?? null,
        appStoreConnectIssuerIdEnvVar: input.appStoreConnectIssuerIdEnvVar ?? null,
        appStoreConnectKeyPathEnvVar: input.appStoreConnectKeyPathEnvVar ?? null,
        signingMode: input.signingMode ?? 'match',
        appleTeamId: input.appleTeamId ?? null,
        signingCertificate: input.signingCertificate?.trim() || 'Apple Distribution',
        provisioningProfilesJson: JSON.stringify(normalizeProvisioningProfiles(input.provisioningProfiles)),
        larkNotificationChatId: input.larkNotificationChatId?.trim() || null,
      });

    return this.findByKey(input.projectKey)!;
  }

  update(projectKey: string, input: ProjectUpdateInput): Project | null {
    const result = this.database
      .prepare(`
        UPDATE projects
        SET display_name = @displayName,
            repo_path = @repoPath,
            fastlane_lane = @fastlaneLane,
            scheme = @scheme,
            build_configuration = @buildConfiguration,
            firebase_app_id = @firebaseAppId,
            firebase_tester_groups_json = @firebaseTesterGroupsJson,
            firebase_cli_token_env_var = @firebaseCliTokenEnvVar,
            match_password_env_var = @matchPasswordEnvVar,
            app_store_connect_key_id_env_var = @appStoreConnectKeyIdEnvVar,
            app_store_connect_issuer_id_env_var = @appStoreConnectIssuerIdEnvVar,
            app_store_connect_key_path_env_var = @appStoreConnectKeyPathEnvVar,
            signing_mode = @signingMode,
            apple_team_id = @appleTeamId,
            signing_certificate = @signingCertificate,
            provisioning_profiles_json = @provisioningProfilesJson,
            lark_notification_chat_id = @larkNotificationChatId,
            enabled = 0,
            validation_status = 'unknown',
            validation_message = NULL,
            validated_at = NULL,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE project_key = @projectKey COLLATE NOCASE AND version = @version
      `)
      .run({
        projectKey,
        ...input,
        scheme: input.scheme ?? null,
        buildConfiguration: input.buildConfiguration ?? null,
        firebaseTesterGroupsJson: JSON.stringify(normalizeGroups(input.firebaseTesterGroups)),
        matchPasswordEnvVar: input.matchPasswordEnvVar ?? null,
        appStoreConnectKeyIdEnvVar: input.appStoreConnectKeyIdEnvVar ?? null,
        appStoreConnectIssuerIdEnvVar: input.appStoreConnectIssuerIdEnvVar ?? null,
        appStoreConnectKeyPathEnvVar: input.appStoreConnectKeyPathEnvVar ?? null,
        signingMode: input.signingMode ?? 'match',
        appleTeamId: input.appleTeamId ?? null,
        signingCertificate: input.signingCertificate?.trim() || 'Apple Distribution',
        provisioningProfilesJson: JSON.stringify(normalizeProvisioningProfiles(input.provisioningProfiles)),
        larkNotificationChatId: input.larkNotificationChatId?.trim() || null,
      });

    return result.changes === 1 ? this.findByKey(projectKey) : null;
  }

  setValidation(
    projectKey: string,
    status: ProjectValidationStatus,
    message: string | null,
    expectedVersion?: number,
  ): Project | null {
    const result = this.database
      .prepare(`
        UPDATE projects
        SET validation_status = ?, validation_message = ?, validated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE project_key = ? COLLATE NOCASE
          AND (? IS NULL OR version = ?)
      `)
      .run(status, message, projectKey, expectedVersion ?? null, expectedVersion ?? null);
    return result.changes === 1 ? this.findByKey(projectKey) : null;
  }

  setEnabled(projectKey: string, enabled: boolean): Project | null {
    const result = this.database
      .prepare(`
        UPDATE projects
        SET enabled = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE project_key = ? COLLATE NOCASE
          AND (? = 0 OR validation_status = 'valid')
      `)
      .run(enabled ? 1 : 0, projectKey, enabled ? 1 : 0);
    return result.changes === 1 ? this.findByKey(projectKey) : null;
  }

  delete(projectKey: string): boolean {
    const activeBuild = this.database
      .prepare(`
        SELECT 1 FROM build_records
        WHERE project_id = ? COLLATE NOCASE AND status IN ('enqueueing', 'queued', 'running')
        LIMIT 1
      `)
      .get(projectKey);

    if (activeBuild) {
      return false;
    }

    return this.database.prepare('DELETE FROM projects WHERE project_key = ? COLLATE NOCASE').run(projectKey).changes === 1;
  }

  countEnabled(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM projects WHERE enabled = 1').get() as {
      count: number;
    };
    return row.count;
  }

  toSnapshot(project: Project): ProjectConfigSnapshotV2 {
    const manualSigning = project.signingMode === 'manual';

    return {
      schemaVersion: 2,
      projectKey: project.projectKey,
      displayName: project.displayName,
      repoPath: project.repoPath,
      fastlaneLane: project.fastlaneLane,
      scheme: project.scheme,
      buildConfiguration: project.buildConfiguration,
      firebaseAppId: project.firebaseAppId,
      firebaseTesterGroups: [...project.firebaseTesterGroups],
      signingMode: project.signingMode,
      appleTeamId: manualSigning ? project.appleTeamId : null,
      signingCertificate: project.signingCertificate,
      provisioningProfiles: manualSigning ? normalizeProvisioningProfiles(project.provisioningProfiles) : [],
      larkNotificationChatId: project.larkNotificationChatId,
      secretEnvRefs: {
        firebaseCliToken: project.firebaseCliTokenEnvVar,
        matchPassword: manualSigning ? null : project.matchPasswordEnvVar,
        appStoreConnectKeyId: manualSigning ? null : project.appStoreConnectKeyIdEnvVar,
        appStoreConnectIssuerId: manualSigning ? null : project.appStoreConnectIssuerIdEnvVar,
        appStoreConnectKeyPath: manualSigning ? null : project.appStoreConnectKeyPathEnvVar,
      },
      projectVersion: project.version,
    };
  }
}
