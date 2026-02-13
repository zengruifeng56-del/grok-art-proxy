import { Hono } from "hono";
import type { Env } from "../env";
import { getToken, getRandomToken, getGlobalCfClearance, type TokenRow } from "../repo/tokens";
import { generateImages, type StreamUpdate } from "../grok/imagine";
import { generateVideo, type VideoUpdate } from "../grok/video";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

const MAX_RETRIES = 5;

function isRetryableTokenError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("429") ||
    lowered.includes("too many requests") ||
    lowered.includes("rate limited") ||
    lowered.includes("cloudflare challenge") ||
    lowered.includes("upstream 403") ||
    lowered.includes("401") ||
    lowered.includes("unauthorized")
  );
}

function getRetryableErrorReason(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes("cloudflare challenge") || lowered.includes("upstream 403")) {
    return "Cloudflare challenge (403)";
  }
  if (
    lowered.includes("429") ||
    lowered.includes("rate limited") ||
    lowered.includes("too many requests")
  ) {
    return "Rate limited (429)";
  }
  if (lowered.includes("401") || lowered.includes("unauthorized")) {
    return "Unauthorized (401)";
  }
  return "Retryable upstream error";
}

// Image generation (SSE stream) with auto-retry on 429
app.post("/api/imagine/generate", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    aspect_ratio?: string;
    enable_nsfw?: boolean;
    count?: number;
    token_id?: string;
  }>();

  const { prompt, aspect_ratio = "2:3", enable_nsfw = true, count = 10, token_id } = body;

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);

  // Generate images with retry logic
  void (async () => {
    const excludedTokenIds: string[] = [];
    let retryCount = 0;
    let totalCollected = 0;
    const targetCount = count;
    let lastRetryableError = "";

    while (retryCount < MAX_RETRIES && totalCollected < targetCount) {
      // Get token (excluding rate-limited ones)
      let token: TokenRow | null = null;

      if (token_id && retryCount === 0) {
        token = await getToken(db, token_id);
      }

      if (!token) {
        token = await getRandomToken(db, excludedTokenIds);
      }

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens failed with retryable errors (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens. Please import tokens first.",
          });
        }
        break;
      }

      try {
        const remainingCount = targetCount - totalCollected;
        const effectiveCfClearance = globalCfClearance || token.cf_clearance;

        for await (const update of generateImages(
          token.sso,
          token.sso_rw,
          prompt,
          remainingCount,
          aspect_ratio,
          enable_nsfw,
          token.user_id,
          effectiveCfClearance
        )) {
          if (update.type === "error") {
            const msg = update.message;

            // Check for 429 rate limit
            if (isRetryableTokenError(msg)) {
              lastRetryableError = msg;
              excludedTokenIds.push(token.id);
              retryCount++;
              const reason = getRetryableErrorReason(msg);

              await writeEvent("info", {
                type: "info",
                message: `Retryable error: ${reason}, switching token (attempt ${retryCount}/${MAX_RETRIES})`,
              });

              // Break inner loop to retry with new token
              break;
            } else {
              // Other error, propagate it
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "image") {
            totalCollected++;
            await writeEvent("image", update);

            // Update progress with total collected
            await writeEvent("progress", {
              type: "progress",
              job_id: update.job_id,
              status: "collecting",
              percentage: (totalCollected / targetCount) * 100,
              completed_count: totalCollected,
              target_count: targetCount,
            });
          } else if (update.type === "progress") {
            // Forward progress events (except collecting which we handle above)
            if (update.status !== "collecting") {
              await writeEvent("progress", update);
            }
          } else if (update.type === "done") {
            // Check if we got enough
            if (totalCollected >= targetCount) {
              await writeEvent("done", {});
              await writer.close();
              return;
            }
            // Otherwise continue with next token if needed
            break;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (isRetryableTokenError(message)) {
          lastRetryableError = message;
          excludedTokenIds.push(token.id);
          retryCount++;
          const reason = getRetryableErrorReason(message);

          await writeEvent("info", {
            type: "info",
            message: `Retryable error: ${reason}, switching token (attempt ${retryCount}/${MAX_RETRIES})`,
          });
          continue;
        } else {
          await writeEvent("error", {
            type: "error",
            message,
          });
          break;
        }
      }
    }

    // Final done event
    if (totalCollected > 0) {
      await writeEvent("done", {});
    } else if (retryCount >= MAX_RETRIES) {
      await writeEvent("error", {
        type: "error",
        message: lastRetryableError
          ? `Retry limit reached (${MAX_RETRIES}): ${lastRetryableError}`
          : `Retry limit reached (${MAX_RETRIES})`,
      });
    }
    await writer.close();
  })().catch((err) => {
    console.error("imagine generate background task failed:", err);
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Video generation (SSE stream) with auto-retry on 429
app.post("/api/video/generate", async (c) => {
  const body = await c.req.json<{
    image_url: string;
    prompt: string;
    parent_post_id: string;
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    mode?: string;
    token_id?: string;
  }>();

  const {
    image_url,
    prompt,
    parent_post_id,
    aspect_ratio = "2:3",
    video_length = 6,
    resolution = "480p",
    mode = "custom",
    token_id,
  } = body;

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);

  // Generate video with retry logic
  void (async () => {
    const excludedTokenIds: string[] = [];
    let retryCount = 0;
    let lastRetryableError = "";

    while (retryCount < MAX_RETRIES) {
      // Get token (excluding rate-limited ones)
      let token: TokenRow | null = null;

      if (token_id && retryCount === 0) {
        token = await getToken(db, token_id);
      }

      if (!token) {
        token = await getRandomToken(db, excludedTokenIds);
      }

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens failed with retryable errors (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens. Please import tokens first.",
          });
        }
        break;
      }

      try {
        let completed = false;
        const effectiveCfClearance = globalCfClearance || token.cf_clearance;

        for await (const update of generateVideo(
          token.sso,
          token.sso_rw,
          token.user_id,
          effectiveCfClearance,
          token.id,
          image_url,
          prompt,
          parent_post_id,
          aspect_ratio,
          video_length,
          resolution,
          mode
        )) {
          if (update.type === "error") {
            const msg = update.message;

            // Check for 429 rate limit
            if (isRetryableTokenError(msg)) {
              lastRetryableError = msg;
              excludedTokenIds.push(token.id);
              retryCount++;
              const reason = getRetryableErrorReason(msg);

              await writeEvent("info", {
                type: "info",
                message: `Retryable error: ${reason}, switching token (attempt ${retryCount}/${MAX_RETRIES})`,
              });

              break;
            } else {
              // Other error, propagate it
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "complete") {
            await writeEvent("complete", update);
            completed = true;
          } else if (update.type === "progress") {
            await writeEvent("progress", update);
          } else if (update.type === "done") {
            if (completed) {
              await writeEvent("done", {});
              await writer.close();
              return;
            }
          }
        }

        // If we got here without completing, try next token
        if (!completed) {
          continue;
        }
        break;

      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (isRetryableTokenError(message)) {
          lastRetryableError = message;
          excludedTokenIds.push(token.id);
          retryCount++;
          const reason = getRetryableErrorReason(message);

          await writeEvent("info", {
            type: "info",
            message: `Retryable error: ${reason}, switching token (attempt ${retryCount}/${MAX_RETRIES})`,
          });
          continue;
        } else {
          await writeEvent("error", {
            type: "error",
            message,
          });
          break;
        }
      }
    }

    if (retryCount >= MAX_RETRIES) {
      await writeEvent("error", {
        type: "error",
        message: lastRetryableError
          ? `Retry limit reached (${MAX_RETRIES}): ${lastRetryableError}`
          : `Retry limit reached (${MAX_RETRIES})`,
      });
    }

    await writer.close();
  })().catch((err) => {
    console.error("video generate background task failed:", err);
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Scroll/load more images (SSE stream) with auto-retry on 429
app.post("/api/imagine/scroll", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    aspect_ratio?: string;
    enable_nsfw?: boolean;
    max_pages?: number;
  }>();

  const { prompt, aspect_ratio = "2:3", enable_nsfw = true, max_pages = 1 } = body;

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;
  const globalCfClearance = await getGlobalCfClearance(db);

  // Scroll with retry logic
  void (async () => {
    const excludedTokenIds: string[] = [];
    let retryCount = 0;
    const imagesPerPage = 6;
    const targetCount = max_pages * imagesPerPage;
    let lastRetryableError = "";
    let emittedAnyImage = false;

    while (retryCount < MAX_RETRIES) {
      const token = await getRandomToken(db, excludedTokenIds);

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens failed with retryable errors (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens.",
          });
        }
        break;
      }

      try {
        const effectiveCfClearance = globalCfClearance || token.cf_clearance;

        for await (const update of generateImages(
          token.sso,
          token.sso_rw,
          prompt,
          targetCount,
          aspect_ratio,
          enable_nsfw,
          token.user_id,
          effectiveCfClearance
        )) {
          if (update.type === "error") {
            const msg = update.message;

            if (isRetryableTokenError(msg)) {
              lastRetryableError = msg;
              excludedTokenIds.push(token.id);
              retryCount++;
              const reason = getRetryableErrorReason(msg);

              await writeEvent("info", {
                type: "info",
                message: `Retryable error: ${reason}, switching token (attempt ${retryCount}/${MAX_RETRIES})`,
              });
              break;
            } else {
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "image") {
            emittedAnyImage = true;
            await writeEvent("image", update);
          } else if (update.type === "done") {
            await writeEvent("done", {});
            await writer.close();
            return;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (isRetryableTokenError(message)) {
          lastRetryableError = message;
          excludedTokenIds.push(token.id);
          retryCount++;
          continue;
        } else {
          await writeEvent("error", { type: "error", message });
          break;
        }
      }
    }

    if (!emittedAnyImage && retryCount >= MAX_RETRIES) {
      await writeEvent("error", {
        type: "error",
        message: lastRetryableError
          ? `Retry limit reached (${MAX_RETRIES}): ${lastRetryableError}`
          : `Retry limit reached (${MAX_RETRIES})`,
      });
    }

    await writeEvent("done", {});
    await writer.close();
  })().catch((err) => {
    console.error("imagine scroll background task failed:", err);
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export { app as imagineRoutes };
