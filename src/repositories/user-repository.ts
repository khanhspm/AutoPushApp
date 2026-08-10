import type { AppDatabase } from '../db/database';
import type { CmsUser, CmsUserInput, UserRow } from '../domain/user';

interface PermissionRow {
  project_id: string;
}

export class UserRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): CmsUser[] {
    const rows = this.database.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE, id').all() as UserRow[];
    return rows.map((row) => this.mapUser(row));
  }

  findById(id: string): CmsUser | null {
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? this.mapUser(row) : null;
  }

  create(input: CmsUserInput): CmsUser {
    this.database
      .prepare('INSERT INTO users (id, display_name, enabled) VALUES (?, ?, ?)')
      .run(input.id, input.displayName, input.enabled === false ? 0 : 1);
    return this.findById(input.id)!;
  }

  update(id: string, input: Omit<CmsUserInput, 'id'>): CmsUser | null {
    const result = this.database
      .prepare(`
        UPDATE users
        SET display_name = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(input.displayName, input.enabled === false ? 0 : 1, id);
    return result.changes === 1 ? this.findById(id) : null;
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM users WHERE id = ?').run(id).changes === 1;
  }

  replaceProjectPermissions(userId: string, projectKeys: string[]): CmsUser | null {
    const replace = this.database.transaction(() => {
      const user = this.database.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
      if (!user) {
        return false;
      }

      this.database.prepare('DELETE FROM project_user_permissions WHERE user_id = ?').run(userId);
      const insert = this.database.prepare(`
        INSERT INTO project_user_permissions (project_id, user_id, can_build)
        VALUES (?, ?, 1)
      `);

      for (const projectKey of [...new Set(projectKeys)]) {
        insert.run(projectKey, userId);
      }

      return true;
    });

    return replace.immediate() ? this.findById(userId) : null;
  }

  canBuildProject(userId: string, projectKey: string): boolean {
    return Boolean(
      this.database
        .prepare(`
          SELECT 1
          FROM users u
          JOIN project_user_permissions permission ON permission.user_id = u.id
          JOIN projects project ON project.project_key = permission.project_id
          WHERE u.id = ? AND u.enabled = 1
            AND project.project_key = ? COLLATE NOCASE AND project.enabled = 1
            AND permission.can_build = 1
        `)
        .get(userId, projectKey),
    );
  }

  countEnabled(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM users WHERE enabled = 1').get() as {
      count: number;
    };
    return row.count;
  }

  private mapUser(row: UserRow): CmsUser {
    const permissions = this.database
      .prepare(`
        SELECT project_id FROM project_user_permissions
        WHERE user_id = ? AND can_build = 1
        ORDER BY project_id COLLATE NOCASE
      `)
      .all(row.id) as PermissionRow[];

    return {
      id: row.id,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      projectKeys: permissions.map((permission) => permission.project_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
