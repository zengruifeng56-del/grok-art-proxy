/**
 * Model mapping from OpenAI model IDs to Grok internal model names and modes.
 * Supports built-in static models and dynamic model IDs synced from x.ai.
 */

export interface ModelInfo {
  id: string;
  grokModel: string;
  modelMode: string;
  displayName: string;
  type: "text" | "image" | "video";
}

export interface ResolvedModelInfo {
  requested: string;
  matchedBy: "exact" | "alias" | "wildcard" | "prefix";
  model: ModelInfo;
  candidates: string[];
}

export interface ModelCatalogEntry {
  id: string;
  type: "text" | "image" | "video";
  displayName: string;
  grokModel: string | null;
  modelMode: string | null;
  source: "builtin" | "xai";
  canonicalId: string | null;
  usable: boolean;
}

export interface XaiModelSyncOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  ttlMs?: number | undefined;
  force?: boolean | undefined;
}

export interface XaiModelSyncResult {
  ok: boolean;
  fromCache: boolean;
  ids: string[];
  updatedAt: number | null;
  error?: string;
  status?: number;
}

export interface ModelCatalogListOptions {
  type?: ModelInfo["type"] | undefined;
  q?: string | undefined;
  includeUnsupported?: boolean | undefined;
}

interface XaiModelCacheState {
  ids: string[];
  updatedAt: number;
  lastError: string;
  lastStatus: number;
}

interface CandidateModel {
  id: string;
  model: ModelInfo;
  source: "builtin" | "xai";
}

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_TTL_MS = 5 * 60 * 1000;
const xaiModelCache: XaiModelCacheState = {
  ids: [],
  updatedAt: 0,
  lastError: "",
  lastStatus: 0,
};

// Supported aspect ratios
const SUPPORTED_RATIOS = ["1:1", "2:3", "3:2", "16:9", "9:16"] as const;
type AspectRatio = (typeof SUPPORTED_RATIOS)[number];

// Ratio suffix to actual ratio mapping
const RATIO_SUFFIX_MAP: Record<string, AspectRatio> = {
  "1_1": "1:1",
  "2_3": "2:3",
  "3_2": "3:2",
  "16_9": "16:9",
  "9_16": "9:16",
};

// Grok model modes
const MODEL_MODE_AUTO = "MODEL_MODE_AUTO";
const MODEL_MODE_FAST = "MODEL_MODE_FAST";
const MODEL_MODE_HEAVY = "MODEL_MODE_HEAVY";
const MODEL_MODE_GROK_4_MINI_THINKING = "MODEL_MODE_GROK_4_MINI_THINKING";
const MODEL_MODE_GROK_4_1_THINKING = "MODEL_MODE_GROK_4_1_THINKING";
const MODEL_MODE_EXPERT = "MODEL_MODE_EXPERT";

export const MODELS: ModelInfo[] = [
  // Grok 3 series
  {
    id: "grok-3",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_AUTO,
    displayName: "Grok 3",
    type: "text",
  },
  {
    id: "grok-3-fast",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok 3 Fast",
    type: "text",
  },
  // Grok 4 series
  {
    id: "grok-4",
    grokModel: "grok-4",
    modelMode: MODEL_MODE_AUTO,
    displayName: "Grok 4",
    type: "text",
  },
  {
    id: "grok-4-mini",
    grokModel: "grok-4-mini-thinking-tahoe",
    modelMode: MODEL_MODE_GROK_4_MINI_THINKING,
    displayName: "Grok 4 Mini",
    type: "text",
  },
  {
    id: "grok-4-fast",
    grokModel: "grok-4",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok 4 Fast",
    type: "text",
  },
  {
    id: "grok-4-heavy",
    grokModel: "grok-4",
    modelMode: MODEL_MODE_HEAVY,
    displayName: "Grok 4 Heavy",
    type: "text",
  },
  // Grok 4.1 series
  {
    id: "grok-4.1",
    grokModel: "grok-4-1-thinking-1129",
    modelMode: MODEL_MODE_AUTO,
    displayName: "Grok 4.1",
    type: "text",
  },
  {
    id: "grok-4.1-fast",
    grokModel: "grok-4-1-thinking-1129",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok 4.1 Fast",
    type: "text",
  },
  {
    id: "grok-4.1-expert",
    grokModel: "grok-4-1-thinking-1129",
    modelMode: MODEL_MODE_EXPERT,
    displayName: "Grok 4.1 Expert",
    type: "text",
  },
  {
    id: "grok-4.1-thinking",
    grokModel: "grok-4-1-thinking-1129",
    modelMode: MODEL_MODE_GROK_4_1_THINKING,
    displayName: "Grok 4.1 Thinking",
    type: "text",
  },
  // Image models with aspect ratios
  {
    id: "grok-image",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (1:1)",
    type: "image",
  },
  {
    id: "grok-image-1_1",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (1:1)",
    type: "image",
  },
  {
    id: "grok-image-2_3",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (2:3)",
    type: "image",
  },
  {
    id: "grok-image-3_2",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (3:2)",
    type: "image",
  },
  {
    id: "grok-image-16_9",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (16:9)",
    type: "image",
  },
  {
    id: "grok-image-9_16",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Image (9:16)",
    type: "image",
  },
  // Video models with aspect ratios
  {
    id: "grok-video",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (16:9)",
    type: "video",
  },
  {
    id: "grok-video-1_1",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (1:1)",
    type: "video",
  },
  {
    id: "grok-video-2_3",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (2:3)",
    type: "video",
  },
  {
    id: "grok-video-3_2",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (3:2)",
    type: "video",
  },
  {
    id: "grok-video-16_9",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (16:9)",
    type: "video",
  },
  {
    id: "grok-video-9_16",
    grokModel: "grok-3",
    modelMode: MODEL_MODE_FAST,
    displayName: "Grok Video (9:16)",
    type: "video",
  },
];

const EXACT_ALIAS_MAP: Record<string, string> = {
  "grok4": "grok-4",
  "grok-4-latest": "grok-4",
  "grok4-latest": "grok-4",
  "grok41": "grok-4.1",
  "grok-41": "grok-4.1",
  "grok-4.1-latest": "grok-4.1",
  "grok-image-latest": "grok-image",
  "grok-video-latest": "grok-video",
};

function normalizeModelId(modelId: string): string {
  return String(modelId || "").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = String(baseUrl || DEFAULT_XAI_BASE_URL).trim() || DEFAULT_XAI_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function parseTtlMs(ttlMs?: number): number {
  if (!ttlMs || Number.isNaN(ttlMs) || ttlMs <= 0) {
    return DEFAULT_XAI_TTL_MS;
  }
  return ttlMs;
}

function inferTypeFromModelId(id: string): ModelInfo["type"] {
  const normalized = normalizeModelId(id);
  if (normalized.includes("image")) return "image";
  if (normalized.includes("video")) return "video";
  return "text";
}

function modelById(modelId: string): ModelInfo | undefined {
  const normalized = normalizeModelId(modelId);
  return MODELS.find((m) => normalizeModelId(m.id) === normalized);
}

function mapRemoteModelToCanonicalId(remoteModelId: string): string | null {
  const normalized = normalizeModelId(remoteModelId);
  if (!normalized) return null;

  if (modelById(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("grok-image")) {
    const match = normalized.match(/^grok-image[-_]?(\d+_\d+)$/);
    if (match?.[1]) {
      const candidate = `grok-image-${match[1]}`;
      if (modelById(candidate)) return candidate;
    }
    return "grok-image";
  }

  if (normalized.startsWith("grok-video")) {
    const match = normalized.match(/^grok-video[-_]?(\d+_\d+)$/);
    if (match?.[1]) {
      const candidate = `grok-video-${match[1]}`;
      if (modelById(candidate)) return candidate;
    }
    return "grok-video";
  }

  if (normalized.startsWith("grok-4.1")) {
    if (normalized.includes("expert")) return "grok-4.1-expert";
    if (normalized.includes("thinking")) return "grok-4.1-thinking";
    if (normalized.includes("fast")) return "grok-4.1-fast";
    return "grok-4.1";
  }

  if (normalized.startsWith("grok-4-mini")) {
    return "grok-4-mini";
  }

  if (normalized.startsWith("grok-4")) {
    if (normalized.includes("heavy")) return "grok-4-heavy";
    if (normalized.includes("fast")) return "grok-4-fast";
    return "grok-4";
  }

  if (normalized.startsWith("grok-3")) {
    if (normalized.includes("fast")) return "grok-3-fast";
    return "grok-3";
  }

  return null;
}

function getCanonicalModelForRemote(
  remoteModelId: string,
  type?: ModelInfo["type"]
): { canonicalId: string; model: ModelInfo } | null {
  const canonicalId = mapRemoteModelToCanonicalId(remoteModelId);
  if (!canonicalId) return null;
  const model = modelById(canonicalId);
  if (!model) return null;
  if (type && model.type !== type) return null;
  return { canonicalId: model.id, model };
}

function modelsOfType(type?: ModelInfo["type"]): ModelInfo[] {
  if (!type) return MODELS;
  return MODELS.filter((m) => m.type === type);
}

function getCandidateModels(type?: ModelInfo["type"]): CandidateModel[] {
  const candidates: CandidateModel[] = modelsOfType(type).map((m) => ({
    id: m.id,
    model: m,
    source: "builtin",
  }));
  const seen = new Set(candidates.map((c) => normalizeModelId(c.id)));

  for (const remoteId of xaiModelCache.ids) {
    const normalizedRemoteId = normalizeModelId(remoteId);
    if (!normalizedRemoteId || seen.has(normalizedRemoteId)) {
      continue;
    }

    const mapped = getCanonicalModelForRemote(remoteId, type);
    if (!mapped) {
      continue;
    }

    candidates.push({
      id: remoteId,
      model: mapped.model,
      source: "xai",
    });
    seen.add(normalizedRemoteId);
  }

  return candidates;
}

function findCandidateMatches(query: string, type?: ModelInfo["type"]): CandidateModel[] {
  const normalized = normalizeModelId(query);
  if (!normalized) return [];

  const candidates = getCandidateModels(type);
  if (normalized.includes("*")) {
    const regex = wildcardToRegExp(normalized);
    return candidates.filter((c) => regex.test(c.id));
  }

  return candidates.filter((c) => normalizeModelId(c.id).startsWith(normalized));
}

function pickPreferredCandidate(candidates: CandidateModel[]): CandidateModel {
  if (candidates.length <= 1) return candidates[0]!;
  return [...candidates].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "builtin" ? -1 : 1;
    }
    if (a.id.length !== b.id.length) {
      return a.id.length - b.id.length;
    }
    return normalizeModelId(a.id).localeCompare(normalizeModelId(b.id));
  })[0]!;
}

function parseXaiModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }

  const ids = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { id?: unknown }).id || "").trim();
    if (!id) continue;
    ids.add(id);
  }

  return Array.from(ids);
}

export function getXaiModelCacheState(): {
  ids: string[];
  updatedAt: number | null;
  lastError: string;
  lastStatus: number;
} {
  return {
    ids: [...xaiModelCache.ids],
    updatedAt: xaiModelCache.updatedAt || null,
    lastError: xaiModelCache.lastError,
    lastStatus: xaiModelCache.lastStatus,
  };
}

export async function syncXaiModels(options: XaiModelSyncOptions = {}): Promise<XaiModelSyncResult> {
  const apiKey = String(options.apiKey || "").trim();
  const ttlMs = parseTtlMs(options.ttlMs);
  const force = Boolean(options.force);

  if (!apiKey) {
    return {
      ok: false,
      fromCache: true,
      ids: [...xaiModelCache.ids],
      updatedAt: xaiModelCache.updatedAt || null,
      error: "XAI_API_KEY not configured",
    };
  }

  const now = Date.now();
  if (
    !force &&
    xaiModelCache.ids.length > 0 &&
    xaiModelCache.updatedAt > 0 &&
    now - xaiModelCache.updatedAt < ttlMs
  ) {
    return {
      ok: true,
      fromCache: true,
      ids: [...xaiModelCache.ids],
      updatedAt: xaiModelCache.updatedAt,
      status: xaiModelCache.lastStatus || 200,
    };
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    const status = response.status;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = `x.ai models sync failed: HTTP ${status}${text ? ` - ${text.slice(0, 200)}` : ""}`;
      xaiModelCache.lastError = error;
      xaiModelCache.lastStatus = status;
      return {
        ok: false,
        fromCache: false,
        ids: [...xaiModelCache.ids],
        updatedAt: xaiModelCache.updatedAt || null,
        status,
        error,
      };
    }

    const payload = await response.json().catch(() => null);
    const ids = parseXaiModelIds(payload);
    xaiModelCache.ids = ids;
    xaiModelCache.updatedAt = Date.now();
    xaiModelCache.lastError = "";
    xaiModelCache.lastStatus = status;

    return {
      ok: true,
      fromCache: false,
      ids: [...ids],
      updatedAt: xaiModelCache.updatedAt,
      status,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    xaiModelCache.lastError = `x.ai models sync error: ${error}`;
    xaiModelCache.lastStatus = 0;
    return {
      ok: false,
      fromCache: false,
      ids: [...xaiModelCache.ids],
      updatedAt: xaiModelCache.updatedAt || null,
      error: xaiModelCache.lastError,
    };
  }
}

export async function resolveModelInfoWithSync(
  requestedModel: string,
  type: ModelInfo["type"] | undefined,
  options: XaiModelSyncOptions
): Promise<ResolvedModelInfo | null> {
  const resolved = resolveModelInfo(requestedModel, type);
  if (resolved) return resolved;

  await syncXaiModels({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ttlMs: options.ttlMs,
    force: false,
  });
  return resolveModelInfo(requestedModel, type);
}

export function listModelCatalog(options: ModelCatalogListOptions = {}): ModelCatalogEntry[] {
  const includeUnsupported = options.includeUnsupported ?? true;
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const model of MODELS) {
    if (options.type && model.type !== options.type) continue;
    entries.push({
      id: model.id,
      type: model.type,
      displayName: model.displayName,
      grokModel: model.grokModel,
      modelMode: model.modelMode,
      source: "builtin",
      canonicalId: model.id,
      usable: true,
    });
    seen.add(normalizeModelId(model.id));
  }

  for (const remoteId of xaiModelCache.ids) {
    const normalizedRemoteId = normalizeModelId(remoteId);
    if (!normalizedRemoteId || seen.has(normalizedRemoteId)) continue;

    const inferredType = inferTypeFromModelId(remoteId);
    const mapped = getCanonicalModelForRemote(remoteId);
    const entryType = mapped?.model.type || inferredType;
    if (options.type && entryType !== options.type) continue;

    const usable = Boolean(mapped);
    if (!includeUnsupported && !usable) continue;

    entries.push({
      id: remoteId,
      type: entryType,
      displayName: usable
        ? `${mapped!.model.displayName} (xAI: ${remoteId})`
        : `xAI ${remoteId}`,
      grokModel: mapped?.model.grokModel || null,
      modelMode: mapped?.model.modelMode || null,
      source: "xai",
      canonicalId: mapped?.canonicalId || null,
      usable,
    });
    seen.add(normalizedRemoteId);
  }

  const q = String(options.q || "").trim();
  let filtered = entries;
  if (q) {
    const normalized = normalizeModelId(q);
    if (normalized.includes("*")) {
      const regex = wildcardToRegExp(normalized);
      filtered = filtered.filter((m) => regex.test(m.id));
    } else {
      filtered = filtered.filter((m) => normalizeModelId(m.id).startsWith(normalized));
    }
  }

  filtered.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "builtin" ? -1 : 1;
    }
    return normalizeModelId(a.id).localeCompare(normalizeModelId(b.id));
  });

  return filtered;
}

export function findModelCandidates(query: string, type?: ModelInfo["type"]): ModelInfo[] {
  const matches = findCandidateMatches(query, type);
  const seenModelIds = new Set<string>();
  const output: ModelInfo[] = [];
  for (const item of matches) {
    if (seenModelIds.has(item.model.id)) continue;
    seenModelIds.add(item.model.id);
    output.push(item.model);
  }
  return output;
}

export function resolveModelInfo(requestedModel: string, type?: ModelInfo["type"]): ResolvedModelInfo | null {
  const requested = String(requestedModel || "").trim();
  const normalized = normalizeModelId(requested);
  if (!normalized) return null;

  const candidates = getCandidateModels(type);

  const exact = candidates.find((c) => normalizeModelId(c.id) === normalized);
  if (exact) {
    return {
      requested,
      matchedBy: "exact",
      model: exact.model,
      candidates: [exact.id],
    };
  }

  const aliasTarget = EXACT_ALIAS_MAP[normalized];
  if (aliasTarget) {
    const aliasResolved = modelById(aliasTarget);
    if (aliasResolved && (!type || aliasResolved.type === type)) {
      return {
        requested,
        matchedBy: "alias",
        model: aliasResolved,
        candidates: [aliasResolved.id],
      };
    }
  }

  const wildcardCandidates = findCandidateMatches(requested, type);
  if (wildcardCandidates.length > 0) {
    return {
      requested,
      matchedBy: normalized.includes("*") ? "wildcard" : "prefix",
      model: pickPreferredCandidate(wildcardCandidates).model,
      candidates: wildcardCandidates.map((m) => m.id),
    };
  }

  return null;
}

/**
 * Get model info by OpenAI model ID
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return modelById(modelId);
}

/**
 * Convert OpenAI model ID to Grok model name and mode
 */
export function toGrokModel(modelId: string): { grokModel: string; modelMode: string } | null {
  const model = getModelInfo(modelId);
  if (!model) return null;
  return { grokModel: model.grokModel, modelMode: model.modelMode };
}

/**
 * Check if model is a text model
 */
export function isTextModel(modelId: string): boolean {
  const model = getModelInfo(modelId);
  return model?.type === "text";
}

/**
 * Check if model is a thinking model (shows reasoning process)
 */
export function isThinkingModel(modelId: string): boolean {
  const thinkingModels = ["grok-4-mini", "grok-4.1-thinking"];
  return thinkingModels.includes(modelId);
}

/**
 * Check if model is an image generation model
 */
export function isImageModel(modelId: string): boolean {
  return modelId === "grok-image" || modelId.startsWith("grok-image-");
}

/**
 * Check if model is a video generation model
 */
export function isVideoModel(modelId: string): boolean {
  return modelId === "grok-video" || modelId.startsWith("grok-video-");
}

/**
 * Parse model ID to extract base model and aspect ratio
 * e.g., "grok-image-16_9" -> { baseModel: "grok-image", aspectRatio: "16:9" }
 */
export function parseModelWithRatio(modelId: string): { baseModel: string; aspectRatio: string } {
  // Check for image model with ratio suffix
  if (modelId.startsWith("grok-image-")) {
    const suffix = modelId.slice("grok-image-".length);
    const ratio = RATIO_SUFFIX_MAP[suffix];
    if (ratio) {
      return { baseModel: "grok-image", aspectRatio: ratio };
    }
  }

  // Check for video model with ratio suffix
  if (modelId.startsWith("grok-video-")) {
    const suffix = modelId.slice("grok-video-".length);
    const ratio = RATIO_SUFFIX_MAP[suffix];
    if (ratio) {
      return { baseModel: "grok-video", aspectRatio: ratio };
    }
  }

  // Default ratios for base models
  if (modelId === "grok-image") {
    return { baseModel: "grok-image", aspectRatio: "1:1" };
  }
  if (modelId === "grok-video") {
    return { baseModel: "grok-video", aspectRatio: "16:9" };
  }

  // Unknown model
  return { baseModel: modelId, aspectRatio: "1:1" };
}

/**
 * Check if model requires an input image (video from image)
 * @deprecated No longer used - grok-video-from-image model removed
 */
export function requiresInputImage(_modelId: string): boolean {
  return false;
}
