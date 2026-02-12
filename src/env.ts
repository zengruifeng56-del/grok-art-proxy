import type { DbClient } from "./db-client";

export interface Env {
  DB: DbClient;
  BUILD_SHA?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  VIDEO_POSTER_PREVIEW?: string;
}
