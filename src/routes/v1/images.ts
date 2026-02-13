import { Hono } from "hono";
import type { Env } from "../../env";
import { getRandomToken, getGlobalCfClearance, type TokenRow } from "../../repo/tokens";
import { parseModelWithRatio, resolveModelInfo, resolveModelInfoWithSync } from "../../grok/models";
import { generateImages, type ImageUpdate } from "../../grok/imagine";
import { incrementApiKeyUsage } from "../../repo/api-keys";
import type { ApiAuthEnv } from "../../middleware/api-auth";

const app = new Hono<ApiAuthEnv>();

const MAX_RETRIES = 5;

// OpenAI size to Grok aspect ratio mapping
const SIZE_TO_ASPECT_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1024x1536": "2:3",  // Portrait
  "1536x1024": "3:2",  // Landscape
  "1792x1024": "16:9",
  "1024x1792": "9:16",
};

interface OpenAIImageRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
}

interface OpenAIImageResponse {
  created: number;
  data: Array<{ url?: string; b64_json?: string }>;
}

interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// POST /v1/images/generations - OpenAI compatible image generation
app.post("/generations", async (c) => {
  const body = await c.req.json<OpenAIImageRequest>();
  const requestedModel = String(body.model || "grok-image");
  const ttlParsed = Number.parseInt(String(c.env.XAI_MODELS_CACHE_TTL_MS || "").trim(), 10);
  const ttlMs = Number.isNaN(ttlParsed) || ttlParsed <= 0 ? undefined : ttlParsed;
  const syncOptions = {
    apiKey: c.env.XAI_API_KEY,
    baseUrl: c.env.XAI_BASE_URL,
    ttlMs,
  };
  const resolvedModel = syncOptions.apiKey
    ? await resolveModelInfoWithSync(requestedModel, "image", syncOptions)
    : resolveModelInfo(requestedModel, "image");

  if (!resolvedModel) {
    const errorResponse: OpenAIErrorResponse = {
      error: {
        message: `Model '${requestedModel}' not found for image generation`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    };
    return c.json(errorResponse, 404);
  }

  const {
    prompt,
    n = 1,
    size,
    response_format = "url",
  } = body;

  // Validate prompt
  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    const errorResponse: OpenAIErrorResponse = {
      error: {
        message: "Invalid prompt: prompt is required and must be a non-empty string",
        type: "invalid_request_error",
        param: "prompt",
        code: "invalid_prompt",
      },
    };
    return c.json(errorResponse, 400);
  }

  const parsed = parseModelWithRatio(resolvedModel.model.id);
  let aspectRatio = parsed.aspectRatio || "1:1";

  // size has higher priority when provided explicitly.
  if (size) {
    const fromSize = SIZE_TO_ASPECT_RATIO[size];
    if (!fromSize) {
      const errorResponse: OpenAIErrorResponse = {
        error: {
          message: `Invalid size: ${size}. Supported sizes: ${Object.keys(SIZE_TO_ASPECT_RATIO).join(", ")}`,
          type: "invalid_request_error",
          param: "size",
          code: "invalid_size",
        },
      };
      return c.json(errorResponse, 400);
    }
    aspectRatio = fromSize;
  }

  // Validate n
  const count = Math.min(Math.max(1, n), 10);

  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);
  const collectedImages: Array<{ url?: string; b64_json?: string }> = [];
  const excludedTokenIds: string[] = [];
  let retryCount = 0;

  while (retryCount < MAX_RETRIES && collectedImages.length < count) {
    // Get available token
    const token: TokenRow | null = await getRandomToken(db, excludedTokenIds);

    if (!token) {
      if (excludedTokenIds.length > 0) {
        const errorResponse: OpenAIErrorResponse = {
          error: {
            message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
            type: "server_error",
            param: null,
            code: "rate_limit_exceeded",
          },
        };
        return c.json(errorResponse, 429);
      } else {
        const errorResponse: OpenAIErrorResponse = {
          error: {
            message: "No available tokens. Please import tokens first.",
            type: "server_error",
            param: null,
            code: "no_tokens_available",
          },
        };
        return c.json(errorResponse, 503);
      }
    }

    try {
      const remainingCount = count - collectedImages.length;
      let gotRateLimited = false;

      for await (const update of generateImages(
        token.sso,
        token.sso_rw,
        prompt,
        remainingCount,
        aspectRatio,
        true, // enable_nsfw
        token.user_id,
        globalCfClearance || token.cf_clearance
      )) {
        if (update.type === "error") {
          const msg = update.message;

          // Check for 429 rate limit
          if (msg.includes("429") || msg.includes("Rate limited")) {
            excludedTokenIds.push(token.id);
            retryCount++;
            gotRateLimited = true;
            break;
          } else {
            // Other error
            const errorResponse: OpenAIErrorResponse = {
              error: {
                message: msg,
                type: "server_error",
                param: null,
                code: "generation_failed",
              },
            };
            return c.json(errorResponse, 500);
          }
        } else if (update.type === "image") {
          const imageUpdate = update as ImageUpdate;

          if (response_format === "b64_json") {
            // Extract base64 from image_src or blob
            let b64Data = "";
            if (imageUpdate.image_src.startsWith("data:")) {
              // Extract base64 portion from data URL
              const parts = imageUpdate.image_src.split(",");
              b64Data = parts[1] || "";
            } else if (imageUpdate.has_blob) {
              // Use URL if no blob available
              b64Data = "";
            }

            if (b64Data) {
              collectedImages.push({ b64_json: b64Data });
            } else {
              // Fallback to URL if b64 not available
              collectedImages.push({ url: imageUpdate.url });
            }
          } else {
            // Return URL
            collectedImages.push({ url: imageUpdate.url });
          }

          if (collectedImages.length >= count) {
            break;
          }
        } else if (update.type === "done") {
          // Generation complete for this token
          break;
        }
      }

      if (gotRateLimited) {
        continue;
      }

      // If we got enough images, break the retry loop
      if (collectedImages.length >= count) {
        break;
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (message.includes("429") || message.includes("Rate limited")) {
        excludedTokenIds.push(token.id);
        retryCount++;
        continue;
      } else {
        const errorResponse: OpenAIErrorResponse = {
          error: {
            message,
            type: "server_error",
            param: null,
            code: "generation_failed",
          },
        };
        return c.json(errorResponse, 500);
      }
    }
  }

  // Return collected images (even if fewer than requested)
  if (collectedImages.length === 0) {
    const errorResponse: OpenAIErrorResponse = {
      error: {
        message: "Failed to generate any images after multiple retries",
        type: "server_error",
        param: null,
        code: "generation_failed",
      },
    };
    return c.json(errorResponse, 500);
  }

  // Update API key usage statistics
  const apiKeyInfo = c.get("apiKeyInfo");
  if (apiKeyInfo) {
    await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
  }

  const response: OpenAIImageResponse = {
    created: Math.floor(Date.now() / 1000),
    data: collectedImages,
  };

  return c.json(response);
});

export { app as imagesRoutes };
