import type { AppDatabase } from '../database';

export interface Migration {
  version: number;
  name: string;
  up(database: AppDatabase): void;
}
