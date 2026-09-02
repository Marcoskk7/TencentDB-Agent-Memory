export interface ParsedUsageClaim {
  access_id: string;
  declared_usage: "used" | "not_used" | "uncertain";
  purpose: string;
  decision_refs?: string[];
  behavior_refs?: string[];
  diff_refs?: string[];
  validation_refs?: string[];
  files?: string[];
  reason?: string;
}

export interface ParsedUsageClaims { claims: ParsedUsageClaim[]; text: string; }

const BLOCK = /<asset_usage\s*>([\s\S]*?)<\/asset_usage\s*>/gi;
const MAX_BLOCKS = 8;
const MAX_JSON = 64_000;
const MAX_TEXT = 4_000;

function strings(value: unknown, max = 32): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT)) return undefined;
  return value as string[];
}

export function parseAssetUsage(text: string): ParsedUsageClaims {
  if (typeof text !== "string") return { claims: [], text: "" };
  let claims: ParsedUsageClaim[] = [];
  let count = 0;
  const cleaned = text.replace(BLOCK, (_whole, raw: string) => {
    count += 1;
    if (count > MAX_BLOCKS || raw.length > MAX_JSON) return "";
    try {
      const payload = JSON.parse(raw) as { schema_version?: unknown; claims?: unknown };
      if (payload.schema_version !== 1 || !Array.isArray(payload.claims) || payload.claims.length > 32) return "";
      const parsed = payload.claims.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const c = item as Record<string, unknown>;
        if (typeof c.access_id !== "string" || !c.access_id || c.access_id.length > 300) return [];
        if (!["used", "not_used", "uncertain"].includes(String(c.declared_usage))) return [];
        if (typeof c.purpose !== "string" || !c.purpose || c.purpose.length > MAX_TEXT) return [];
        const decision_refs = strings(c.decision_refs);
        const behavior_refs = strings(c.behavior_refs);
        const diff_refs = strings(c.diff_refs);
        const validation_refs = strings(c.validation_refs);
        const files = strings(c.files);
        if ([decision_refs, behavior_refs, diff_refs, validation_refs, files].some((v, i) => [c.decision_refs, c.behavior_refs, c.diff_refs, c.validation_refs, c.files][i] !== undefined && !v)) return [];
        return [{ access_id: c.access_id, declared_usage: c.declared_usage as ParsedUsageClaim["declared_usage"], purpose: c.purpose, decision_refs, behavior_refs, diff_refs, validation_refs, files, reason: typeof c.reason === "string" && c.reason.length <= MAX_TEXT ? c.reason : undefined }];
      });
      claims = claims.concat(parsed);
    } catch { /* malformed hidden blocks are removed but never become claims */ }
    return "";
  });
  return { claims: claims.slice(0, 32), text: cleaned.replace(/[ \t]+\n/g, "\n").trim() };
}
