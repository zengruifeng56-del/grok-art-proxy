import { applySqlMigrations, createSqliteClient } from "./sqlite";

const dbPath = process.env.DB_PATH || "./data/grok-art-proxy.db";
const migrationsDir = process.env.MIGRATIONS_DIR || "./migrations";

const db = createSqliteClient(dbPath);
applySqlMigrations(db, migrationsDir);

console.log(`migrations applied: db=${dbPath}, dir=${migrationsDir}`);
