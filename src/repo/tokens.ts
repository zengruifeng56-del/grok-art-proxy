import type { Env } from "../env";
import { dbAll, dbFirst, dbRun, dbBatch } from "../db";
import { nowMs } from "../utils/time";
import { md5 } from "../utils/crypto";

export interface TokenRow {
  id: string;
  sso: string;
  sso_rw: string;
  user_id: string;
  cf_clearance: string;
  name: string;
  added_at: number;
  last_used: number | null;
  use_count: number;
  status: string;
  nsfw_enabled: number;
}

export interface TokenInfo {
  id: string;
  name: string;
  sso_preview: string;
  has_sso_rw: boolean;
  has_user_id: boolean;
  has_cf_clearance: boolean;
  status: string;
  nsfw_enabled: boolean;
  use_count: number;
  last_used: string | null;
  added_at: string;
}

export interface TokenExport {
  sso: string;
  sso_rw: string;
  name: string;
  "x-userid": string;
  cf_clearance: string;
}

function generateTokenId(sso: string): string {
  return md5(sso);
}

function cleanSso(sso: string): string {
  return sso.startsWith("sso=") ? sso.slice(4) : sso.trim();
}

export function tokenRowToInfo(row: TokenRow): TokenInfo {
  return {
    id: row.id,
    name: row.name || `${row.sso.slice(0, 8)}...`,
    sso_preview: row.sso.length > 20 ? `${row.sso.slice(0, 20)}...` : row.sso,
    has_sso_rw: Boolean(row.sso_rw),
    has_user_id: Boolean(row.user_id),
    has_cf_clearance: Boolean(row.cf_clearance),
    status: row.status,
    nsfw_enabled: Boolean(row.nsfw_enabled),
    use_count: row.use_count,
    last_used: row.last_used ? new Date(row.last_used).toISOString() : null,
    added_at: new Date(row.added_at).toISOString(),
  };
}

export function tokenRowToExport(row: TokenRow): TokenExport {
  return {
    sso: row.sso,
    sso_rw: row.sso_rw,
    name: row.name,
    "x-userid": row.user_id,
    cf_clearance: row.cf_clearance,
  };
}

export async function listTokens(db: Env["DB"]): Promise<TokenRow[]> {
  return dbAll<TokenRow>(
    db,
    "SELECT id, sso, sso_rw, user_id, cf_clearance, name, added_at, last_used, use_count, status, nsfw_enabled FROM tokens ORDER BY added_at DESC"
  );
}

export async function getToken(db: Env["DB"], tokenId: string): Promise<TokenRow | null> {
  return dbFirst<TokenRow>(
    db,
    "SELECT id, sso, sso_rw, user_id, cf_clearance, name, added_at, last_used, use_count, status, nsfw_enabled FROM tokens WHERE id = ?",
    [tokenId]
  );
}

export async function getRandomToken(db: Env["DB"], excludeIds: string[] = []): Promise<TokenRow | null> {
  const placeholders = excludeIds.length > 0
    ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})`
    : "";

  const rows = await dbAll<TokenRow>(
    db,
    `SELECT id, sso, sso_rw, user_id, cf_clearance, name, added_at, last_used, use_count, status, nsfw_enabled
     FROM tokens WHERE status = 'active' ${placeholders}`,
    excludeIds
  );

  if (rows.length === 0) return null;
  const token = rows[Math.floor(Math.random() * rows.length)];
  if (!token) return null;

  // Update usage stats
  const now = nowMs();
  await dbRun(db, "UPDATE tokens SET last_used = ?, use_count = use_count + 1 WHERE id = ?", [now, token.id]);

  return token;
}

export async function addToken(
  db: Env["DB"],
  sso: string,
  sso_rw: string = "",
  user_id: string = "",
  cf_clearance: string = "",
  name: string = ""
): Promise<TokenRow> {
  const cleanedSso = cleanSso(sso);
  const id = generateTokenId(cleanedSso);
  const now = nowMs();

  // Check if exists
  const existing = await getToken(db, id);
  if (existing) {
    // Update existing token
    const updates: string[] = [];
    const params: unknown[] = [];

    if (sso_rw) { updates.push("sso_rw = ?"); params.push(sso_rw); }
    if (user_id) { updates.push("user_id = ?"); params.push(user_id); }
    if (cf_clearance) { updates.push("cf_clearance = ?"); params.push(cf_clearance); }
    if (name) { updates.push("name = ?"); params.push(name); }

    if (updates.length > 0) {
      params.push(id);
      await dbRun(db, `UPDATE tokens SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    return (await getToken(db, id))!;
  }

  // Insert new token
  await dbRun(
    db,
    `INSERT INTO tokens (id, sso, sso_rw, user_id, cf_clearance, name, added_at, use_count, status, nsfw_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 0)`,
    [id, cleanedSso, sso_rw, user_id, cf_clearance, name || `${cleanedSso.slice(0, 8)}...`, now]
  );

  return (await getToken(db, id))!;
}

export interface ParsedTokenInput {
  sso: string;
  sso_rw: string;
  user_id: string;
  cf_clearance: string;
  name: string;
}

export function parseTokensText(text: string): ParsedTokenInput[] {
  const result: ParsedTokenInput[] = [];
  const trimmed = text.trim();

  // Try JSON format
  if (trimmed.startsWith("[")) {
    try {
      const items = JSON.parse(trimmed) as unknown[];
      for (const item of items) {
        if (typeof item === "string") {
          const sso = item.startsWith("sso=") ? item.slice(4) : item.trim();
          if (sso) result.push({ sso, sso_rw: "", user_id: "", cf_clearance: "", name: "" });
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const sso = String(obj.sso || "");
          if (sso) {
            result.push({
              sso,
              sso_rw: String(obj.sso_rw || obj["sso-rw"] || ""),
              user_id: String(obj.user_id || obj["x-userid"] || ""),
              cf_clearance: String(obj.cf_clearance || ""),
              name: String(obj.name || ""),
            });
          }
        }
      }
      return result;
    } catch {
      // Not valid JSON, continue with line parsing
    }
  }

  // Parse by lines
  for (const line of trimmed.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) continue;

    let sso = "", sso_rw = "", user_id = "", cf_clearance = "", name = "";

    if (cleaned.includes(",")) {
      const parts = cleaned.split(",").map(p => p.trim());
      sso = parts[0] ?? "";
      sso_rw = parts[1] ?? "";
      user_id = parts[2] ?? "";
      cf_clearance = parts[3] ?? "";
      name = parts[4] ?? "";
    } else {
      sso = cleaned;
    }

    if (sso.startsWith("sso=")) sso = sso.slice(4);
    if (sso) result.push({ sso, sso_rw, user_id, cf_clearance, name });
  }

  return result;
}

// Batch import tokens with high performance (uses INSERT OR REPLACE)
export async function addTokensBulk(
  db: Env["DB"],
  items: ParsedTokenInput[]
): Promise<{ count: number }> {
  if (items.length === 0) return { count: 0 };

  const now = nowMs();
  const BATCH_SIZE = 50; // D1 batch limit
  let totalInserted = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const statements: { sql: string; params: unknown[] }[] = [];

    for (const item of batch) {
      const cleanedSso = cleanSso(item.sso);
      if (!cleanedSso) continue;

      const id = generateTokenId(cleanedSso);
      const name = item.name || `${cleanedSso.slice(0, 8)}...`;

      statements.push({
        sql: `INSERT INTO tokens (id, sso, sso_rw, user_id, cf_clearance, name, added_at, use_count, status, nsfw_enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 0)
              ON CONFLICT(id) DO UPDATE SET
                sso_rw = CASE WHEN excluded.sso_rw != '' THEN excluded.sso_rw ELSE tokens.sso_rw END,
                user_id = CASE WHEN excluded.user_id != '' THEN excluded.user_id ELSE tokens.user_id END,
                cf_clearance = CASE WHEN excluded.cf_clearance != '' THEN excluded.cf_clearance ELSE tokens.cf_clearance END,
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE tokens.name END`,
        params: [id, cleanedSso, item.sso_rw, item.user_id, item.cf_clearance, name, now],
      });
    }

    if (statements.length > 0) {
      await dbBatch(db, statements);
      totalInserted += statements.length;
    }
  }

  return { count: totalInserted };
}

export async function addTokensBatch(
  db: Env["DB"],
  text: string
): Promise<{ count: number; tokens: TokenRow[] }> {
  const added: TokenRow[] = [];
  const trimmed = text.trim();

  // Try JSON format
  if (trimmed.startsWith("[")) {
    try {
      const items = JSON.parse(trimmed) as unknown[];
      for (const item of items) {
        if (typeof item === "string") {
          const token = await addToken(db, item);
          added.push(token);
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const token = await addToken(
            db,
            String(obj.sso || ""),
            String(obj.sso_rw || obj["sso-rw"] || ""),
            String(obj.user_id || obj["x-userid"] || ""),
            String(obj.cf_clearance || ""),
            String(obj.name || "")
          );
          added.push(token);
        }
      }
      return { count: added.length, tokens: added };
    } catch {
      // Not valid JSON, continue with line parsing
    }
  }

  // Parse by lines
  for (const line of trimmed.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) continue;

    let sso = "", sso_rw = "", user_id = "", cf_clearance = "", name = "";

    if (cleaned.includes(",")) {
      // CSV format: sso,sso_rw,user_id,cf_clearance,name
      const parts = cleaned.split(",").map(p => p.trim());
      sso = parts[0] ?? "";
      sso_rw = parts[1] ?? "";
      user_id = parts[2] ?? "";
      cf_clearance = parts[3] ?? "";
      name = parts[4] ?? "";
    } else {
      sso = cleaned;
    }

    if (sso.startsWith("sso=")) sso = sso.slice(4);
    if (sso) {
      const token = await addToken(db, sso, sso_rw, user_id, cf_clearance, name);
      added.push(token);
    }
  }

  return { count: added.length, tokens: added };
}

export async function deleteToken(db: Env["DB"], tokenId: string): Promise<boolean> {
  const existing = await getToken(db, tokenId);
  if (!existing) return false;
  await dbRun(db, "DELETE FROM tokens WHERE id = ?", [tokenId]);
  return true;
}

export async function clearAllTokens(db: Env["DB"]): Promise<void> {
  await dbRun(db, "DELETE FROM tokens");
}

export async function setTokenNsfw(db: Env["DB"], tokenId: string, enabled: boolean): Promise<void> {
  await dbRun(db, "UPDATE tokens SET nsfw_enabled = ? WHERE id = ?", [enabled ? 1 : 0, tokenId]);
}

export async function getTokenStats(db: Env["DB"]): Promise<{ total: number; active: number }> {
  const total = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM tokens");
  const active = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM tokens WHERE status = 'active'");
  return {
    total: total?.c ?? 0,
    active: active?.c ?? 0,
  };
}
