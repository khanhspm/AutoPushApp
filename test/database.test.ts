import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import { migrations } from '../src/db/migrations';
import { ProjectRepository } from '../src/repositories/project-repository';
import { UserRepository } from '../src/repositories/user-repository';

const databases: AppDatabase[] = [];

function database(): AppDatabase {
  const db = createDatabase(':memory:');
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('database migrations and repositories', () => {
  it('creates projects and enforces project user permissions', () => {
    const db = database();
    migrateDatabase(db);
    const projects = new ProjectRepository(db);
    const users = new UserRepository(db);

    projects.create({
      projectKey: 'MyApp',
      displayName: 'My App',
      repoPath: '/tmp/my-app',
      fastlaneLane: 'distribute',
      scheme: 'MyApp',
      firebaseAppId: '1:123:ios:abc',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'MYAPP_FIREBASE_TOKEN',
    });
    projects.setValidation('MyApp', 'valid', 'ok');
    projects.setEnabled('MyApp', true);
    users.create({ id: 'ou_123', displayName: 'Builder' });
    users.replaceProjectPermissions('ou_123', ['MyApp']);

    expect(projects.findByKey('myapp')).toMatchObject({
      enabled: true,
      buildConfiguration: 'Debug',
      signingMode: 'match',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [],
      larkNotificationChatId: null,
    });
    expect(users.canBuildProject('ou_123', 'MyApp')).toBe(true);
  });

  it('preserves an explicit null build configuration for runner defaults', () => {
    const db = database();
    migrateDatabase(db);
    const projects = new ProjectRepository(db);

    const project = projects.create({
      projectKey: 'RunnerDefault',
      displayName: 'Runner Default',
      repoPath: '/tmp/runner-default',
      fastlaneLane: 'distribute',
      buildConfiguration: null,
      firebaseAppId: '1:123:ios:runner',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'RUNNER_FIREBASE_TOKEN',
    });

    expect(project.buildConfiguration).toBeNull();
  });

  it('persists manual signing mappings and snapshots only active signing settings', () => {
    const db = database();
    migrateDatabase(db);
    const projects = new ProjectRepository(db);

    const project = projects.create({
      projectKey: 'ManualApp',
      displayName: 'Manual App',
      repoPath: '/tmp/manual-app',
      fastlaneLane: 'distribute',
      scheme: 'ManualApp',
      firebaseAppId: '1:123:ios:manual',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'MANUAL_FIREBASE_TOKEN',
      matchPasswordEnvVar: 'STALE_MATCH_PASSWORD',
      appStoreConnectKeyIdEnvVar: 'STALE_ASC_KEY_ID',
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [
        { bundleId: 'com.example.app', profileName: ' Example App AdHoc ' },
        { bundleId: 'com.example.app.widget', profileName: 'Example Widget AdHoc' },
      ],
      larkNotificationChatId: 'oc_manual_app_group',
    });

    expect(project.provisioningProfiles[0]).toEqual({ bundleId: 'com.example.app', profileName: 'Example App AdHoc' });
    expect(projects.toSnapshot(project)).toMatchObject({
      schemaVersion: 2,
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      provisioningProfiles: project.provisioningProfiles,
      larkNotificationChatId: 'oc_manual_app_group',
      secretEnvRefs: {
        firebaseCliToken: 'MANUAL_FIREBASE_TOKEN',
        matchPassword: null,
        appStoreConnectKeyId: null,
      },
    });
  });

  it('adds a nullable Lark group to existing projects', () => {
    const db = database();
    migrateDatabase(db, migrations.slice(0, 3));
    db.prepare(`
      INSERT INTO projects (
        project_key, display_name, repo_path, fastlane_lane, firebase_app_id,
        firebase_tester_groups_json, firebase_cli_token_env_var
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('ExistingApp', 'Existing App', '/tmp/existing-app', 'distribute', '1:123:ios:existing', '["qa"]', 'EXISTING_FIREBASE_TOKEN');

    const result = migrateDatabase(db);
    const project = new ProjectRepository(db).findByKey('ExistingApp');

    expect(result.appliedVersions).toEqual([4, 5, 6]);
    expect(project?.larkNotificationChatId).toBeNull();
  });

  it('migrates the original build history schema without exposing legacy log paths', () => {
    const db = database();
    db.exec(`
      CREATE TABLE build_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        build_number TEXT NOT NULL,
        release_notes TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        log_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO build_records (
        project_id, build_number, release_notes, requested_by, chat_id, status, log_path
      ) VALUES ('LegacyApp', '10', 'legacy', 'ou_legacy', 'oc_chat', 'success', '/tmp/unsafe.log');
    `);

    migrateDatabase(db);
    const row = db.prepare('SELECT * FROM build_records').get() as {
      id: string;
      project_key_snapshot: string;
      app_version: string | null;
      requested_scheme: string | null;
      log_rel_path: string | null;
    };

    expect(row.id).toMatch(/^legacy-/);
    expect(row.project_key_snapshot).toBe('LegacyApp');
    expect(row.app_version).toBeNull();
    expect(row.requested_scheme).toBeNull();
    expect(row.log_rel_path).toBeNull();
  });
});
