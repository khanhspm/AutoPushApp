import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import { ProjectRepository } from '../src/repositories/project-repository';
import { ProjectConfigService } from '../src/services/project-config-service';

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('project signing validation', () => {
  it('ignores inactive Match references for manual signing', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    migrateDatabase(database);
    const projects = new ProjectRepository(database);
    const project = projects.create({
      projectKey: 'ManualApp',
      displayName: 'Manual App',
      repoPath: '/tmp/manual-app',
      fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:manual',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'MANUAL_FIREBASE_TOKEN',
      matchPasswordEnvVar: 'legacy-match-password',
      appStoreConnectKeyIdEnvVar: 'legacy-key-id',
      appStoreConnectIssuerIdEnvVar: 'legacy-issuer-id',
      appStoreConnectKeyPathEnvVar: 'legacy-key-path',
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
    });

    const result = await new ProjectConfigService(projects, []).validate(project);

    expect(result).toEqual({ valid: false, message: 'IOS_REPO_ROOTS is not configured' });
  });
});
