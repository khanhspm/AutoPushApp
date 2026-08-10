import { env } from '../config/env';
import { createMigratedDatabase } from './migrate';

const database = createMigratedDatabase(env.DB_PATH);

database.close();
console.log(`SQLite migrations completed for ${env.DB_PATH}`);
