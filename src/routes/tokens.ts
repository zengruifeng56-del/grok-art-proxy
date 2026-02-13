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
import { enableNsfw } from "../grok/nsfw";

const app = new Hono<{ Bindings: Env }>();

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
