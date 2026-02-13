import { getWebSocketHeaders, buildCookie } from "./headers";
import WebSocket, { type RawData } from "ws";

const WS_URL = "wss://grok.com/ws/imagine/listen";

export interface ImageResult {
  job_id: string;
  request_id: string;
  url: string;
  blob: string;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ProgressUpdate {
  type: "progress";
  job_id: string;
  status: string;
  percentage: number;
  completed_count: number;
  target_count: number;
}

export interface ImageUpdate {
  type: "image";
  job_id: string;
  request_id: string;
  url: string;
  image_src: string;
  has_blob: boolean;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ErrorUpdate {
  type: "error";
  message: string;
}

export interface InfoUpdate {
  type: "info";
  message: string;
}

export interface DoneUpdate {
  type: "done";
}

export type StreamUpdate = ProgressUpdate | ImageUpdate | ErrorUpdate | InfoUpdate | DoneUpdate;

function buildRequest(
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean,
  isScroll: boolean
): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    timestamp: Date.now(),
    item: {
      type: "message",
      content: [{
        requestId: crypto.randomUUID(),
        text: prompt,
        type: isScroll ? "input_scroll" : "input_text",
        properties: {
          section_count: 0,
          is_kids_mode: false,
          enable_nsfw: enableNsfw,
          skip_upsampler: false,
          is_initial: false,
          aspect_ratio: aspectRatio,
        },
      }],
    },
  };
}

interface WsMessage {
  type: string;
  job_id?: string;
  request_id?: string;
  url?: string;
  blob?: string;
  prompt?: string;
  full_prompt?: string;
  width?: number;
  height?: number;
  model_name?: string;
  grid_index?: number;
  order?: number;
  r_rated?: boolean;
  moderated?: boolean;
  current_status?: string;
  percentage_complete?: number;
  message?: string;
}

async function connectAndReceive(
  sso: string,
  sso_rw: string,
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean,
  isScroll: boolean,
  timeoutMs: number = 30000,
  user_id: string = "",
  cf_clearance: string = ""
): Promise<ImageResult[]> {
  const cookie = buildCookie(sso, sso_rw, user_id, cf_clearance);
  const headers = getWebSocketHeaders(cookie);
  return new Promise((resolve, reject) => {
    const results: ImageResult[] = [];
    const receivedImages: Map<string, ImageResult> = new Map();
    const completedJobs = new Set<string>();
    const failedJobs = new Set<string>();
    const emittedJobs = new Set<string>();
    const ws = new WebSocket(WS_URL, { headers });
    let settled = false;

    const resolveOnce = (value: ImageResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve(value);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      reject(error);
    };

    const timeout = setTimeout(() => {
      resolveOnce(results);
    }, timeoutMs);

    ws.on("open", () => {
      const request = buildRequest(prompt, aspectRatio, enableNsfw, isScroll);
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (raw: RawData) => {
      try {
        const data: WsMessage = JSON.parse(rawToText(raw));
        const msgType = data.type;

        if (msgType === "json") {
          const jobId = data.job_id || "";
          const status = data.current_status || "";
          const percentage = data.percentage_complete || 0;

          if (status === "completed" && percentage >= 100) {
            completedJobs.add(jobId);
          } else if (status === "error") {
            failedJobs.add(jobId);
          }
        } else if (msgType === "image") {
          const jobId = data.job_id || "";
          const blob = data.blob || "";
          const url = data.url || "";
          const blobLen = blob.length;

          if (jobId) {
            const existing = receivedImages.get(jobId);
            const existingBlobLen = existing?.blob?.length || 0;

            // Check if this is a full image (blob > 100KB or URL ends with .jpg)
            const isFullImage = blobLen > 100000 || url.endsWith(".jpg");

            // Update to larger blob
            if (!existing || blobLen > existingBlobLen) {
              const result: ImageResult = {
                job_id: jobId,
                request_id: data.request_id || "",
                url: url,
                blob: blob,
                prompt: data.prompt || "",
                full_prompt: data.full_prompt || "",
                width: data.width || 0,
                height: data.height || 0,
                model_name: data.model_name || "",
                grid_index: data.grid_index || 0,
                order: data.order || 0,
                r_rated: data.r_rated || false,
                moderated: data.moderated || false,
              };
              receivedImages.set(jobId, result);

              // Only add to results when we receive full image
              if (isFullImage && !result.moderated && !emittedJobs.has(jobId)) {
                emittedJobs.add(jobId);
                results.push(result);
              }
            }
          }
        } else if (msgType === "error") {
          const errorMsg = data.message || "Unknown error";
          rejectOnce(new Error(errorMsg));
          return;
        }

        // Check if batch is done (6 jobs completed or failed)
        const totalDone = completedJobs.size + failedJobs.size;
        if (totalDone >= 6) {
          setTimeout(() => {
            resolveOnce(results);
          }, 300);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("error", () => {
      rejectOnce(new Error("WebSocket error"));
    });

    ws.on("close", (code: number) => {
      if (settled) return;
      if (code === 1008 || code === 429) {
        rejectOnce(new Error("Rate limited (429)"));
      } else {
        resolveOnce(results);
      }
    });
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => Buffer.from(part))).toString("utf8");
  return raw.toString("utf8");
}

export async function* generateImages(
  sso: string,
  sso_rw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean,
  user_id: string = "",
  cf_clearance: string = ""
): AsyncGenerator<StreamUpdate> {
  const collectedJobs = new Set<string>();
  const maxPages = Math.ceil(count / 6) + 2;

  yield {
    type: "progress",
    job_id: "",
    status: "starting",
    percentage: 0,
    completed_count: 0,
    target_count: count,
  };

  for (let page = 0; page < maxPages; page++) {
    if (collectedJobs.size >= count) break;

    const isScroll = page > 0;

    try {
      const images = await connectAndReceive(
        sso,
        sso_rw,
        prompt,
        aspectRatio,
        enableNsfw,
        isScroll,
        30000,
        user_id,
        cf_clearance
      );

      for (const img of images) {
        if (img.moderated || !img.url) continue;
        if (collectedJobs.has(img.job_id)) continue;

        collectedJobs.add(img.job_id);

        // Determine image source
        let imageSrc = img.url;
        if (img.blob) {
          if (img.blob.startsWith("data:")) {
            imageSrc = img.blob;
          } else if (img.blob.startsWith("/9j/")) {
            imageSrc = `data:image/jpeg;base64,${img.blob}`;
          } else {
            imageSrc = `data:image/png;base64,${img.blob}`;
          }
        }

        yield {
          type: "image",
          job_id: img.job_id,
          request_id: img.request_id,
          url: img.url,
          image_src: imageSrc,
          has_blob: Boolean(img.blob),
          prompt: img.prompt,
          full_prompt: img.full_prompt,
          width: img.width,
          height: img.height,
          model_name: img.model_name,
          grid_index: img.grid_index,
          order: img.order,
          r_rated: img.r_rated,
          moderated: img.moderated,
        };

        yield {
          type: "progress",
          job_id: img.job_id,
          status: "collecting",
          percentage: (collectedJobs.size / count) * 100,
          completed_count: collectedJobs.size,
          target_count: count,
        };

        if (collectedJobs.size >= count) break;
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("429") || message.includes("Rate limited")) {
        yield { type: "error", message: "Rate limited (429)" };
        return;
      }
      yield { type: "error", message };
      return;
    }

    // Small delay between pages
    if (page < maxPages - 1 && collectedJobs.size < count) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  yield { type: "done" };
}
