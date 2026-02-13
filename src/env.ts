import type { DbClient } from "./db-client";

export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: DbClient;
  ASSETS?: AssetBinding;
  BUILD_SHA?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  VIDEO_POSTER_PREVIEW?: string;
  XAI_API_KEY?: string;
  XAI_BASE_URL?: string;
  XAI_MODELS_CACHE_TTL_MS?: string;
}
