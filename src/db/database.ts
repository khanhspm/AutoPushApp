import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export type AppDatabase = Database.Database;

export interface DatabaseFactoryOptions {
  busyTimeoutMs?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

function isInMemoryDatabase(filename: string): boolean {
  return filename === ':memory:' || filename.startsWith('file::memory:');
}

function ensureParentDirectory(filename: string): void {
  if (isInMemoryDatabase(filename) || filename.startsWith('file:')) {
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

/**
 * Opens and configures a database connection. Calling this function is explicit;
 * importing the module never opens a file or runs migrations.
 */
export function createDatabase(filename: string, options: DatabaseFactoryOptions = {}): AppDatabase {
  if (!filename.trim()) {
    throw new Error('A SQLite database filename is required');
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error('busyTimeoutMs must be a non-negative safe integer');
  }

  ensureParentDirectory(filename);

  const database = new Database(filename, {
    timeout: busyTimeoutMs,
    verbose: options.verbose,
  });

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
