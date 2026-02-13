import { Hono } from "hono";
import type { Env } from "../../env";
import { getRandomToken, getGlobalCfClearance, type TokenRow } from "../../repo/tokens";
import { parseModelWithRatio, resolveModelInfo, resolveModelInfoWithSync } from "../../grok/models";
import { generateVideo, type VideoUpdate } from "../../grok/video";
import { incrementApiKeyUsage } from "../../repo/api-keys";
import type { ApiAuthEnv } from "../../middleware/api-auth";

const app = new Hono<ApiAuthEnv>();

const MAX_RETRIES = 5;

function isRetryableTokenError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("429") ||
    lowered.includes("rate limited") ||
    lowered.includes("cloudflare challenge") ||
    lowered.includes("upstream 403")
  );
}

interface VideoGenerationRequest {
  model?: string;
  image_url: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
}

interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

function createErrorResponse(message: string, status: number): Response {
  const errorBody: OpenAIErrorResponse = {
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === 429 ? "rate_limit_exceeded" : null,
    },
  };
  return new Response(JSON.stringify(errorBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Extract post_id from image URL or create a new media post.
 * Grok image URLs typically have format: https://assets.grok.com/{post_id}.png
 */
function extractPostIdFromUrl(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    // Try to extract from path: /abc123.png -> abc123
    const match = url.pathname.match(/\/([a-zA-Z0-9_-]+)\.(png|jpg|jpeg|webp)$/i);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

// POST /v1/videos/generations
app.post("/generations", async (c) => {
  const body = await c.req.json<VideoGenerationRequest>();
  const requestedModel = String(body.model || "grok-video");
  const ttlParsed = Number.parseInt(String(c.env.XAI_MODELS_CACHE_TTL_MS || "").trim(), 10);
  const ttlMs = Number.isNaN(ttlParsed) || ttlParsed <= 0 ? undefined : ttlParsed;
  const syncOptions = {
    apiKey: c.env.XAI_API_KEY,
    baseUrl: c.env.XAI_BASE_URL,
    ttlMs,
  };
  const resolvedModel = syncOptions.apiKey
    ? await resolveModelInfoWithSync(requestedModel, "video", syncOptions)
    : resolveModelInfo(requestedModel, "video");

  // Validate required fields
  if (!body.image_url) {
    return createErrorResponse("image_url is required", 400);
  }
  if (!resolvedModel) {
    return createErrorResponse(`Model '${requestedModel}' not found for video generation`, 404);
  }

  const {
    image_url,
    prompt = "",
    duration = 6,
    resolution = "720p",
  } = body;

  // Validate duration
  if (duration !== 6 && duration !== 10) {
    return createErrorResponse("duration must be 6 or 10", 400);
  }

  // Validate resolution
  if (resolution !== "480p" && resolution !== "720p") {
    return createErrorResponse("resolution must be '480p' or '720p'", 400);
  }

  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);

  // Try to extract post_id from URL
  const postId = extractPostIdFromUrl(image_url);

  // Retry logic with token rotation
  const excludedTokenIds: string[] = [];
  let retryCount = 0;
  let videoUrl: string | null = null;
  let lastError = "";
  const { aspectRatio } = parseModelWithRatio(resolvedModel.model.id);

  while (retryCount < MAX_RETRIES) {
    const token: TokenRow | null = await getRandomToken(db, excludedTokenIds);

    if (!token) {
      if (excludedTokenIds.length > 0) {
        return createErrorResponse(
          `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
          429
        );
      }
      return createErrorResponse(
        "No available tokens. Please import tokens first.",
        503
      );
    }

    try {
      // Use extracted postId or empty string (generateVideo will create one)
      const actualPostId = postId || "";

      for await (const update of generateVideo(
        token.sso,
        token.sso_rw,
        token.user_id,
        globalCfClearance || token.cf_clearance,
        token.id,
        image_url,
        prompt,
        actualPostId,
        aspectRatio,
        duration,
        resolution,
        "custom"
      )) {
        if (update.type === "error") {
          const msg = update.message;

          // Check for 429 rate limit
          if (isRetryableTokenError(msg)) {
            excludedTokenIds.push(token.id);
            retryCount++;
            lastError = msg;
            break;
          }

          // Other error, return immediately
          return createErrorResponse(msg, 500);
        }

        if (update.type === "complete") {
          videoUrl = update.original_url;
        }

        if (update.type === "done" && videoUrl) {
          // Update API key usage statistics
          const apiKeyInfo = c.get("apiKeyInfo");
          if (apiKeyInfo) {
            await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
          }
          // Success - return OpenAI-compatible response
          return c.json({
            created: Math.floor(Date.now() / 1000),
            data: [{ url: videoUrl }],
          });
        }
      }

      // If we have a video URL but loop ended, return it
      if (videoUrl) {
        // Update API key usage statistics
        const apiKeyInfo = c.get("apiKeyInfo");
        if (apiKeyInfo) {
          await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
        }
        return c.json({
          created: Math.floor(Date.now() / 1000),
          data: [{ url: videoUrl }],
        });
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (isRetryableTokenError(message)) {
        excludedTokenIds.push(token.id);
        retryCount++;
        lastError = message;
        continue;
      }

      return createErrorResponse(message, 500);
    }
  }

  // All retries exhausted
  return createErrorResponse(
    lastError || "Video generation failed after multiple attempts",
    429
  );
});

export { app as videosRoutes };
