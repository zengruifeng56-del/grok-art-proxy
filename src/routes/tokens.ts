import { Hono } from "hono";
import type { Env } from "../env";
import {
  listTokens,
  getToken,
  getRandomToken,
  addToken,
  addTokensBatch,
  addTokensBulk,
  parseTokensText,
  deleteToken,
  clearAllTokens,
  setTokenNsfw,
  getTokenStats,
  tokenRowToInfo,
  tokenRowToExport,
  getGlobalCfClearance,
  setGlobalCfClearance,
} from "../repo/tokens";
import {
  getXaiModelCacheState,
  listModelCatalog,
  resolveModelInfo,
  resolveModelInfoWithSync,
  syncXaiModels,
  type ModelInfo,
} from "../grok/models";
import { streamChat } from "../grok/chat";
import { enableNsfw } from "../grok/nsfw";

const app = new Hono<{ Bindings: Env }>();
const MODEL_TEST_MAX_RETRIES = 3;

function isRetryableModelTestError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("429") ||
    lowered.includes("rate limited") ||
    lowered.includes("too many requests") ||
    lowered.includes("cloudflare challenge") ||
    lowered.includes("upstream 403") ||
    lowered.includes("401") ||
    lowered.includes("unauthorized")
  );
}

function parseTtlMs(raw: string | undefined): number | undefined {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function getXaiSyncOptions(env: Env): {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  ttlMs?: number | undefined;
} {
  return {
    apiKey: env.XAI_API_KEY,
    baseUrl: env.XAI_BASE_URL,
    ttlMs: parseTtlMs(env.XAI_MODELS_CACHE_TTL_MS),
  };
}

// Get global cf_clearance setting
app.get("/api/settings/cf-clearance", async (c) => {
  const cfClearance = await getGlobalCfClearance(c.env.DB);
  return c.json({
    success: true,
    cf_clearance: cfClearance,
  });
});

// Set global cf_clearance setting
app.post("/api/settings/cf-clearance", async (c) => {
  let cfClearance = "";
  try {
    const body = await c.req.json<{ cf_clearance?: string }>();
    cfClearance = String(body.cf_clearance || "");
  } catch {
    cfClearance = "";
  }
  await setGlobalCfClearance(c.env.DB, cfClearance);
  return c.json({
    success: true,
    message: "Global cf_clearance saved",
  });
});

// List models for web admin (cookie-auth protected)
app.get("/api/models", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  const typeQuery = String(c.req.query("type") || "").trim() as ModelInfo["type"] | "";
  const syncQuery = String(c.req.query("sync") || "").trim().toLowerCase();
  const syncRequested = syncQuery === "1" || syncQuery === "true" || syncQuery === "yes";
  const typeFilter = typeQuery === "text" || typeQuery === "image" || typeQuery === "video"
    ? typeQuery
    : undefined;

  const syncOptions = getXaiSyncOptions(c.env);
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
    includeUnsupported: true,
  });
  const cacheState = getXaiModelCacheState();

  return c.json({
    success: true,
    models: models.map((m) => ({
      id: m.id,
      type: m.type,
      display_name: m.displayName,
      grok_model: m.grokModel,
      model_mode: m.modelMode,
      source: m.source,
      canonical_id: m.canonicalId,
      usable: m.usable,
    })),
    xai: {
      enabled: xaiEnabled,
      sync_requested: syncRequested,
      sync_ok: syncResult?.ok ?? false,
      sync_from_cache: syncResult?.fromCache ?? false,
      sync_error: syncResult?.error || "",
      remote_count: cacheState.ids.length,
      updated_at: cacheState.updatedAt,
    },
  });
});

// Resolve model mapping for web admin (supports wildcard)
app.get("/api/models/resolve", async (c) => {
  const requested = String(c.req.query("model") || "").trim();
  const typeQuery = String(c.req.query("type") || "").trim() as ModelInfo["type"] | "";
  const syncQuery = String(c.req.query("sync") || "").trim().toLowerCase();
  const syncRequested = syncQuery === "1" || syncQuery === "true" || syncQuery === "yes";
  const typeFilter = typeQuery === "text" || typeQuery === "image" || typeQuery === "video"
    ? typeQuery
    : undefined;

  if (!requested) {
    return c.json({ success: false, error: "Missing model query parameter" }, 400);
  }

  const syncOptions = getXaiSyncOptions(c.env);
  if (syncRequested && syncOptions.apiKey) {
    await syncXaiModels({
      ...syncOptions,
      force: true,
    });
  }

  const resolved = syncOptions.apiKey
    ? await resolveModelInfoWithSync(requested, typeFilter, syncOptions)
    : resolveModelInfo(requested, typeFilter);
  const candidates = listModelCatalog({
    type: typeFilter,
    q: requested,
    includeUnsupported: true,
  }).map((m) => m.id);

  return c.json({
    success: true,
    requested,
    resolved: resolved ? {
      id: resolved.model.id,
      type: resolved.model.type,
      display_name: resolved.model.displayName,
      grok_model: resolved.model.grokModel,
      model_mode: resolved.model.modelMode,
      matched_by: resolved.matchedBy,
    } : null,
    candidates,
    xai: {
      enabled: Boolean(syncOptions.apiKey),
      remote_count: getXaiModelCacheState().ids.length,
    },
  });
});

// Smoke test text model connectivity with keyword matching.
app.post("/api/models/test", async (c) => {
  const parsed = await c.req
    .json<{ model?: string; keyword?: string; prompt?: string }>()
    .catch(() => null);
  const body: { model?: string; keyword?: string; prompt?: string } = parsed || {};
  const requestedModel = String(body.model || "").trim();
  const keyword = String(body.keyword || "MODEL_OK").trim() || "MODEL_OK";
  const prompt = String(body.prompt || `请仅回复关键词：${keyword}`).trim();

  if (!requestedModel) {
    return c.json({ success: false, connected: false, error: "Missing model" }, 400);
  }

  const syncOptions = getXaiSyncOptions(c.env);
  const resolved = syncOptions.apiKey
    ? await resolveModelInfoWithSync(requestedModel, "text", syncOptions)
    : resolveModelInfo(requestedModel, "text");
  if (!resolved) {
    return c.json(
      {
        success: false,
        connected: false,
        error: `Text model '${requestedModel}' not found`,
      },
      404
    );
  }

  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);
  const excludedTokenIds: string[] = [];
  let retryCount = 0;
  let lastRetryableError = "";

  while (retryCount < MODEL_TEST_MAX_RETRIES) {
    const token = await getRandomToken(db, excludedTokenIds);
    if (!token) {
      const hasRetried = excludedTokenIds.length > 0;
      return c.json(
        {
          success: false,
          connected: false,
          requested_model: requestedModel,
          resolved_model: resolved.model.id,
          matched_by: resolved.matchedBy,
          keyword,
          prompt,
          attempts: retryCount,
          error: hasRetried
            ? `All tokens failed with retryable errors (tried ${excludedTokenIds.length})`
            : "No available tokens",
        },
        hasRetried ? 429 : 503
      );
    }

    let reply = "";
    let shouldRetry = false;

    try {
      for await (const update of streamChat(
        token.sso,
        token.sso_rw,
        [{ role: "user", content: prompt }],
        resolved.model.id,
        false,
        "",
        "",
        false,
        token.user_id,
        globalCfClearance || token.cf_clearance
      )) {
        if (update.type === "error") {
          const msg = String(update.message || "Unknown upstream error");
          if (isRetryableModelTestError(msg)) {
            if (!excludedTokenIds.includes(token.id)) {
              excludedTokenIds.push(token.id);
            }
            retryCount++;
            lastRetryableError = msg;
            shouldRetry = true;
            break;
          }

          return c.json(
            {
              success: false,
              connected: false,
              requested_model: requestedModel,
              resolved_model: resolved.model.id,
              matched_by: resolved.matchedBy,
              keyword,
              prompt,
              attempts: retryCount + 1,
              token_id: token.id,
              reply_preview: reply.slice(0, 400),
              error: msg,
            },
            500
          );
        }

        if (update.type === "token" && update.content) {
          reply += update.content;
          if (reply.length > 4000) {
            reply = reply.slice(0, 4000);
          }
        }

        if (update.type === "done") {
          if (!reply.trim()) {
            if (!excludedTokenIds.includes(token.id)) {
              excludedTokenIds.push(token.id);
            }
            retryCount++;
            lastRetryableError = "Upstream returned empty response";
            shouldRetry = true;
            break;
          }

          const matched = reply.toLowerCase().includes(keyword.toLowerCase());
          return c.json({
            success: true,
            connected: matched,
            requested_model: requestedModel,
            resolved_model: resolved.model.id,
            matched_by: resolved.matchedBy,
            keyword,
            prompt,
            attempts: retryCount + 1,
            token_id: token.id,
            reply_preview: reply.slice(0, 400),
            message: matched ? "Keyword matched, model is connected" : "Response received, but keyword not matched",
          });
        }
      }

      if (shouldRetry) {
        continue;
      }

      if (!excludedTokenIds.includes(token.id)) {
        excludedTokenIds.push(token.id);
      }
      retryCount++;
      lastRetryableError = "Upstream stream ended unexpectedly";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isRetryableModelTestError(message)) {
        if (!excludedTokenIds.includes(token.id)) {
          excludedTokenIds.push(token.id);
        }
        retryCount++;
        lastRetryableError = message;
        continue;
      }

      return c.json(
        {
          success: false,
          connected: false,
          requested_model: requestedModel,
          resolved_model: resolved.model.id,
          matched_by: resolved.matchedBy,
          keyword,
          prompt,
          attempts: retryCount + 1,
          token_id: token.id,
          reply_preview: reply.slice(0, 400),
          error: message,
        },
        500
      );
    }
  }

  return c.json(
    {
      success: false,
      connected: false,
      requested_model: requestedModel,
      resolved_model: resolved.model.id,
      matched_by: resolved.matchedBy,
      keyword,
      prompt,
      attempts: retryCount,
      error: lastRetryableError || `Failed after retries (${MODEL_TEST_MAX_RETRIES})`,
    },
    429
  );
});

// List all tokens
app.get("/api/tokens", async (c) => {
  const stats = await getTokenStats(c.env.DB);
  const tokens = await listTokens(c.env.DB);

  return c.json({
    success: true,
    total: stats.total,
    active: stats.active,
    tokens: tokens.map(tokenRowToInfo),
  });
});

// Export all tokens (full data)
app.get("/api/tokens/export", async (c) => {
  const tokens = await listTokens(c.env.DB);

  return c.json({
    success: true,
    total: tokens.length,
    tokens: tokens.map(tokenRowToExport),
  });
});

// Import tokens batch with high-performance bulk insert
app.post("/api/tokens/import", async (c) => {
  const body = await c.req.json<{ text: string }>();
  const parsed = parseTokensText(body.text);

  if (parsed.length === 0) {
    return c.json({
      success: false,
      error: "没有找到有效的令牌",
      imported: 0,
    });
  }

  // Use fast bulk import for all sizes
  const result = await addTokensBulk(c.env.DB, parsed);
  const stats = await getTokenStats(c.env.DB);

  return c.json({
    success: true,
    imported: result.count,
    total: stats.total,
  });
});

// Add single token
app.post("/api/tokens/add", async (c) => {
  const body = await c.req.json<{
    sso: string;
    sso_rw?: string;
    user_id?: string;
    name?: string;
  }>();

  const token = await addToken(
    c.env.DB,
    body.sso,
    body.sso_rw || "",
    body.user_id || "",
    "",
    body.name || ""
  );
  const stats = await getTokenStats(c.env.DB);

  return c.json({
    success: true,
    token: { id: token.id, name: token.name },
    total: stats.total,
  });
});

// Delete token
app.delete("/api/tokens/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deleteToken(c.env.DB, id);

  if (!deleted) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  const stats = await getTokenStats(c.env.DB);
  return c.json({ success: true, total: stats.total });
});

// Clear all tokens
app.delete("/api/tokens", async (c) => {
  await clearAllTokens(c.env.DB);
  return c.json({ success: true, total: 0 });
});

// Enable NSFW for all tokens (batch mode to avoid subrequest limits)
// Process max 20 tokens per request in PARALLEL to maximize speed
// Each token needs 2 subrequests, so 20 * 2 = 40 < 50 limit
app.post("/api/tokens/enable-nsfw", async (c) => {
  const body = await c.req.json<{ offset?: number }>().catch(() => ({ offset: 0 }));
  const offset = body.offset || 0;
  const BATCH_SIZE = 20; // Parallel execution: 20 * 2 = 40 subrequests < 50 limit

  const tokens = await listTokens(c.env.DB);
  const tokensToProcess = tokens.filter((t) => !t.nsfw_enabled);

  if (tokensToProcess.length === 0) {
    return c.json({
      success: true,
      message: "所有 Token 都已开启 NSFW",
      total: 0,
      processed: 0,
      skipped: tokens.length,
      done: true,
    });
  }

  // Get current batch
  const batch = tokensToProcess.slice(offset, offset + BATCH_SIZE);

  // Process all tokens in parallel for maximum speed
  const batchResults = await Promise.all(
    batch.map(async (token) => {
      const result = await enableNsfw(token.sso, token.sso_rw);
      return { token, result };
    })
  );

  // Update database and collect results
  const results: { name: string; success: boolean; message: string }[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const { token, result } of batchResults) {
    if (result.success) {
      successCount++;
      await setTokenNsfw(c.env.DB, token.id, true);
    } else {
      failCount++;
    }

    results.push({
      name: token.name,
      success: result.success,
      message: result.message,
    });
  }

  const newOffset = offset + batch.length;
  const done = newOffset >= tokensToProcess.length;

  return c.json({
    success: true,
    results,
    success_count: successCount,
    fail_count: failCount,
    processed: newOffset,
    total: tokensToProcess.length,
    skipped: tokens.length - tokensToProcess.length,
    done,
    next_offset: done ? null : newOffset,
  });
});

// Enable NSFW for single token
app.post("/api/tokens/:id/enable-nsfw", async (c) => {
  const id = c.req.param("id");
  const token = await getToken(c.env.DB, id);

  if (!token) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  const result = await enableNsfw(token.sso, token.sso_rw);

  if (result.success) {
    await setTokenNsfw(c.env.DB, id, true);
  }

  return c.json({
    success: result.success,
    message: result.message,
    token_name: token.name,
  });
});

export { app as tokenRoutes };
