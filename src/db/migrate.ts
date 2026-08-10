import { createDatabase, type AppDatabase, type DatabaseFactoryOptions } from './database';
import { migrations as defaultMigrations, type Migration } from './migrations';

interface SchemaMigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  currentVersion: number;
  appliedVersions: number[];
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previousVersion = 0;
  const names = new Set<string>();

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error('Migrations must have unique, positive, strictly increasing integer versions');
    }
    if (!migration.name.trim() || names.has(migration.name)) {
      throw new Error(`Migration names must be non-empty and unique: ${migration.name}`);
    }

    previousVersion = migration.version;
    names.add(migration.name);
  }
}

function ensureMigrationTable(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Applies each pending migration in its own IMMEDIATE transaction. */
export function migrateDatabase(
  database: AppDatabase,
  migrationList: readonly Migration[] = defaultMigrations,
): MigrationResult {
  validateMigrations(migrationList);
  ensureMigrationTable(database);

  const knownByVersion = new Map(migrationList.map((migration) => [migration.version, migration]));
  const alreadyApplied = database
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as SchemaMigrationRow[];

  for (const applied of alreadyApplied) {
    const known = knownByVersion.get(applied.version);
    if (!known) {
      throw new Error(`Database contains unknown migration version ${applied.version} (${applied.name})`);
    }
    if (known.name !== applied.name) {
      throw new Error(
        `Migration ${applied.version} name mismatch: database has ${applied.name}, code has ${known.name}`,
      );
    }
  }

  const applyMigration = database.transaction((migration: Migration): boolean => {
    const applied = database
      .prepare('SELECT name FROM schema_migrations WHERE version = ?')
      .get(migration.version) as Pick<SchemaMigrationRow, 'name'> | undefined;

    if (applied) {
      if (applied.name !== migration.name) {
        throw new Error(
          `Migration ${migration.version} name mismatch: database has ${applied.name}, code has ${migration.name}`,
        );
      }
      return false;
    }

    migration.up(database);
    database
      .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
      .run(migration.version, migration.name);
    return true;
  });

  const appliedVersions: number[] = [];
  for (const migration of migrationList) {
    if (applyMigration.immediate(migration)) {
      appliedVersions.push(migration.version);
    }
  }

  const current = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  return {
    currentVersion: current.version,
    appliedVersions,
  };
}

/** Opens a database and migrates it, closing the connection if migration fails. */
export function createMigratedDatabase(
  filename: string,
  options: DatabaseFactoryOptions = {},
): AppDatabase {
  const database = createDatabase(filename, options);
  try {
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
