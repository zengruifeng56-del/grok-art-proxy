import { serve } from "@hono/node-server";
import type { Env } from "./env";
import { app } from "./index";
import { applySqlMigrations, createSqliteClient } from "./sqlite";

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8787", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 8787;
  }
  return parsed;
}

function createBindings(): Env {
  const dbPath = process.env.DB_PATH || "./data/grok-art-proxy.db";
  const migrationsDir = process.env.MIGRATIONS_DIR || "./migrations";
  const db = createSqliteClient(dbPath);
  applySqlMigrations(db, migrationsDir);
  const env: Env = {
    DB: db,
    BUILD_SHA: process.env.BUILD_SHA || "dev",
    VIDEO_POSTER_PREVIEW: process.env.VIDEO_POSTER_PREVIEW || "true",
  };

  if (process.env.AUTH_USERNAME) {
    env.AUTH_USERNAME = process.env.AUTH_USERNAME;
  }
  if (process.env.AUTH_PASSWORD) {
    env.AUTH_PASSWORD = process.env.AUTH_PASSWORD;
  }

  return env;
}

const port = parsePort(process.env.PORT);
const bindings = createBindings();

serve({
  port,
  fetch: (request) => app.fetch(request, bindings),
});

console.log(`grok-art-proxy server running on port ${port}`);
