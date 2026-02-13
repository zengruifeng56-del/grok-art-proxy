import { Hono } from "hono";
import type { ApiAuthEnv } from "../../middleware/api-auth";
import {
  getXaiModelCacheState,
  listModelCatalog,
  resolveModelInfo,
  resolveModelInfoWithSync,
  syncXaiModels,
  type ModelInfo,
} from "../../grok/models";

const app = new Hono<ApiAuthEnv>();

// GET /v1/models - List available models
app.get("/", (c) => {
  const syncQuery = String(c.req.query("sync") || "").trim().toLowerCase();
  const syncRequested = syncQuery === "1" || syncQuery === "true" || syncQuery === "yes";
  const q = String(c.req.query("q") || "").trim();
  const typeQuery = String(c.req.query("type") || "").trim() as ModelInfo["type"] | "";
  const typeFilter = typeQuery === "text" || typeQuery === "image" || typeQuery === "video"
    ? typeQuery
    : undefined;

  const ttlParsed = Number.parseInt(String(c.env.XAI_MODELS_CACHE_TTL_MS || "").trim(), 10);
  const ttlMs = Number.isNaN(ttlParsed) || ttlParsed <= 0 ? undefined : ttlParsed;
  const syncOptions = {
    apiKey: c.env.XAI_API_KEY,
    baseUrl: c.env.XAI_BASE_URL,
    ttlMs,
  };

  const run = async () => {
    const xaiEnabled = Boolean(syncOptions.apiKey);
    let syncResult: Awaited<ReturnType<typeof syncXaiModels>> | null = null;
    if (xaiEnabled) {
      syncResult = await syncXaiModels({
        ...syncOptions,
        force: syncRequested,
      });
    }

    const models = listModelCatalog({
      type: typeFilter,
      q,
      includeUnsupported: false,
    });

    const resolved = q
      ? (xaiEnabled
        ? await resolveModelInfoWithSync(q, typeFilter, syncOptions)
        : resolveModelInfo(q, typeFilter))
      : null;
    const cacheState = getXaiModelCacheState();

    return c.json({
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: 1700000000,
        owned_by: "xai",
        permission: [],
        root: m.id,
        parent: null,
      })),
      query: q || null,
      resolved_model: resolved?.model.id || null,
      matched_by: resolved?.matchedBy || null,
      xai: {
        enabled: xaiEnabled,
        sync_requested: syncRequested,
        sync_ok: syncResult?.ok ?? false,
        sync_from_cache: syncResult?.fromCache ?? false,
        sync_error: syncResult?.error || "",
        remote_count: cacheState.ids.length,
        updated_at: cacheState.updatedAt,
        last_attempt_at: cacheState.lastAttemptAt,
      },
    });
  };

  return run();
});

export { app as modelsRoutes };
