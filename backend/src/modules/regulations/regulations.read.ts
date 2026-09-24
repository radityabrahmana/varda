// Reading the library: what the Assistant's tools and the detail page use.
// Search runs in Postgres (search_regulation_nodes, ranked full text);
// reading resolves a selector ("pasal 1266-1267", "bab III", "penjelasan
// pasal 5", "outline") against a regulation's nodes.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { REGULATION_NOT_FOUND, visibleFilter } from "./regulations.access";
import { listRegulations } from "./regulations.library";
import type { RegulationNodeRow, RegulationRow, RegulationScope, RegulationSummary } from "./regulations.types";

export const READ_DEFAULT_CHARS = 12_000;
export const READ_MAX_CHARS = 40_000;
const READ_MIN_CHARS = 1_000;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 30;
const CATALOG_INLINE_MAX = 30;

const STRUCTURAL_TYPES = ["buku", "bab", "bagian", "paragraf"];

export function summarizeRegulation(row: RegulationRow): RegulationSummary {
  return {
    id: row.id,
    org_id: row.org_id,
    regulation_type: row.regulation_type,
    issuer: row.issuer,
    number: row.number,
    year: row.year,
    title: row.title,
    short_name: row.short_name,
    status: row.status,
    source_url: row.source_url,
    parse_status: row.parse_status,
    pasal_count: row.pasal_count,
    node_count: row.node_count,
  };
}

/** Cheap gate for the chat engine: does this caller have any regulation at all? */
export async function hasVisibleRegulations(userId: string, db: Db): Promise<boolean> {
  try {
    const { data: memberships } = await db.from("org_members").select("org_id").eq("user_id", userId);
    const orgIds = ((memberships ?? []) as { org_id?: string | null }[])
      .map((m) => m.org_id)
      .filter((id): id is string => Boolean(id));
    const scope: RegulationScope = { userId, orgIds, adminOrgIds: [], platformAdmin: false };
    const { data } = await db.from("regulations").select("id").or(visibleFilter(scope)).eq("parse_status", "parsed").limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Find one visible regulation by id, short name or title. Names are matched
 * loosely ("kuhperdata", "KUH Perdata", "PM 60/2019", "pm 60 2019").
 */
export async function resolveRegulationRef(
  db: Db,
  scope: RegulationScope,
  ref: string,
): Promise<ServiceResult<{ regulation: RegulationRow; candidates: RegulationSummary[] }>> {
  const listed = await listRegulations(db, scope);
  if (!listed.ok) return listed;
  const rows = listed.data;
  const wanted = ref.trim();
  const byId = rows.find((r) => r.id === wanted);
  if (byId) return ok({ regulation: byId, candidates: [] });
  const target = norm(wanted).replace(/\s+/g, "");
  const exact = rows.filter((r) => norm(r.short_name).replace(/\s+/g, "") === target);
  if (exact.length === 1) return ok({ regulation: exact[0], candidates: [] });
  const loose = rows.filter((r) => {
    const sn = norm(r.short_name).replace(/\s+/g, "");
    const title = norm(r.title).replace(/\s+/g, "");
    return sn.includes(target) || target.includes(sn) || title.includes(target);
  });
  if (loose.length === 1) return ok({ regulation: loose[0], candidates: [] });
  const candidates = (loose.length ? loose : rows).slice(0, 10).map(summarizeRegulation);
  return failure(
    "not_found",
    loose.length
      ? `Rujukan "${wanted}" cocok dengan beberapa peraturan; gunakan short_name yang tepat.`
      : `${REGULATION_NOT_FOUND} Rujukan "${wanted}" tidak cocok dengan peraturan di perpustakaan.`,
    JSON.stringify(candidates),
  );
}

// ── Search ─────────────────────────────────────────────────────────────────

export type RegulationSearchHit = {
  regulation: { id: string; short_name: string; title: string; status: string; regulation_type: string; issuer: string | null };
  node_type: string;
  number: string | null;
  heading: string | null;
  context: string | null;
  snippet: string;
  citation: string;
};

export type RegulationSearchResult = {
  query: string;
  hits: RegulationSearchHit[];
  /** The catalog, inline when small, so the model knows what the library holds. */
  library: RegulationSummary[] | { count: number };
};

function citationFor(shortName: string, nodeType: string, number: string | null): string {
  if (nodeType === "pasal" && number) return `Pasal ${number} ${shortName}`;
  if (nodeType === "penjelasan" && number && number !== "UMUM") return `Penjelasan Pasal ${number} ${shortName}`;
  if (nodeType === "penjelasan") return `Penjelasan Umum ${shortName}`;
  if (nodeType === "preamble") return `Pembukaan ${shortName}`;
  return `${shortName}${number ? ` (bagian ${number})` : ""}`;
}

export async function searchRegulationLibrary(
  db: Db,
  scope: RegulationScope,
  params: { query: string; regulation?: string; limit?: number },
): Promise<ServiceResult<RegulationSearchResult>> {
  const query = params.query.trim();
  if (!query) return failure("validation", "query wajib diisi.");
  let regulationId: string | null = null;
  if (params.regulation?.trim()) {
    const resolved = await resolveRegulationRef(db, scope, params.regulation);
    if (!resolved.ok) return resolved;
    regulationId = resolved.data.regulation.id;
  }
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT));
  const { data, error } = await db.rpc("search_regulation_nodes", {
    p_org_ids: scope.orgIds,
    p_query: query,
    p_regulation_id: regulationId,
    p_limit: limit,
  });
  if (error) return internalFailure(error);
  const hits: RegulationSearchHit[] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    regulation: {
      id: String(r.regulation_id),
      short_name: String(r.short_name ?? ""),
      title: String(r.title ?? ""),
      status: String(r.status ?? ""),
      regulation_type: String(r.regulation_type ?? ""),
      issuer: (r.issuer as string | null) ?? null,
    },
    node_type: String(r.node_type),
    number: (r.number as string | null) ?? null,
    heading: (r.heading as string | null) ?? null,
    context: (r.context as string | null) ?? null,
    snippet: String(r.snippet ?? ""),
    citation: citationFor(String(r.short_name ?? ""), String(r.node_type), (r.number as string | null) ?? null),
  }));
  const listed = await listRegulations(db, scope);
  const library = listed.ok
    ? listed.data.length <= CATALOG_INLINE_MAX
      ? listed.data.map(summarizeRegulation)
      : { count: listed.data.length }
    : { count: 0 };
  return ok({ query, hits, library });
}

// ── Read ───────────────────────────────────────────────────────────────────

export type RegulationSelector =
  | { kind: "outline" }
  | { kind: "preamble" }
  | { kind: "penjelasan"; numbers: string[] | null }
  | { kind: "bab"; number: string }
  | { kind: "pasal"; numbers: string[]; ranges: [number, number][] }
  | { kind: "all" };

function romanOrNumber(s: string): string {
  return s.trim().toUpperCase();
}

/** Parse "pasal 5", "pasal 5-9", "pasal 5, 7-9, 12A", "bab III", "penjelasan pasal 5", "outline", "all". */
export function parseRegulationSelector(raw: string): RegulationSelector | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^(outline|daftar isi|struktur)$/.test(s)) return { kind: "outline" };
  if (/^(all|semua|seluruh)$/.test(s)) return { kind: "all" };
  if (/^(menimbang|mengingat|pembukaan|preamble|konsiderans)$/.test(s)) return { kind: "preamble" };
  let m = /^penjelasan(?:\s+(?:umum|pasal\s+(.+)))?$/.exec(s);
  if (m) {
    if (m[1] === undefined) return { kind: "penjelasan", numbers: s.endsWith("umum") ? ["UMUM"] : null };
    const list = parsePasalList(m[1]);
    return list ? { kind: "penjelasan", numbers: list.numbers } : null;
  }
  m = /^bab\s+([ivxlc]+|\d+)$/.exec(s);
  if (m) return { kind: "bab", number: romanOrNumber(m[1]) };
  const list = parsePasalList(s.replace(/^pasal\s+/, ""));
  return list ? { kind: "pasal", ...list } : null;
}

function parsePasalList(s: string): { numbers: string[]; ranges: [number, number][] } | null {
  const numbers: string[] = [];
  const ranges: [number, number][] = [];
  for (const part of s.split(/\s*[,;]\s*/)) {
    const p = part.replace(/^pasal\s+/, "").trim();
    if (!p) continue;
    let m = /^(\d+)\s*(?:-|–|s\.?d\.?|sampai(?: dengan)?)\s*(\d+)$/.exec(p);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a > b) return null;
      ranges.push([a, b]);
      continue;
    }
    m = /^(\d+)\s*([a-z])?$/.exec(p);
    if (!m) return null;
    numbers.push(`${m[1]}${(m[2] ?? "").toUpperCase()}`);
  }
  if (!numbers.length && !ranges.length) return null;
  return { numbers, ranges };
}

type NodeMeta = Pick<RegulationNodeRow, "id" | "node_type" | "number" | "heading" | "context" | "sort_order">;

async function loadNodeMeta(db: Db, regulationId: string): Promise<ServiceResult<NodeMeta[]>> {
  const { data, error } = await db
    .from("regulation_nodes")
    .select("id, node_type, number, heading, context, sort_order")
    .eq("regulation_id", regulationId)
    .order("sort_order", { ascending: true });
  if (error) return internalFailure(error);
  return ok((data ?? []) as NodeMeta[]);
}

async function loadNodeContent(db: Db, ids: number[]): Promise<ServiceResult<RegulationNodeRow[]>> {
  if (!ids.length) return ok([]);
  const { data, error } = await db
    .from("regulation_nodes")
    .select("id, regulation_id, node_type, number, heading, context, content, sort_order")
    .in("id", ids)
    .order("sort_order", { ascending: true });
  if (error) return internalFailure(error);
  return ok((data ?? []) as RegulationNodeRow[]);
}

function pasalNumeric(number: string | null): number {
  const m = /^(\d+)/.exec(number ?? "");
  return m ? Number(m[1]) : Number.NaN;
}

export type RegulationReadResult = {
  regulation: RegulationSummary;
  selector: string;
  outline?: { node_type: string; number: string | null; heading: string | null; context: string | null; pasal_from: string | null; pasal_to: string | null }[];
  sections: { node_type: string; number: string | null; heading: string | null; context: string | null; citation: string; content: string }[];
  total_chars: number;
  truncated: boolean;
  missing: string[];
  note?: string;
};

export async function readRegulation(
  db: Db,
  scope: RegulationScope,
  params: { regulation: string; selector: string; maxChars?: number },
): Promise<ServiceResult<RegulationReadResult>> {
  const resolved = await resolveRegulationRef(db, scope, params.regulation);
  if (!resolved.ok) return resolved;
  const regulation = resolved.data.regulation;
  const selector = parseRegulationSelector(params.selector);
  if (!selector) {
    return failure(
      "validation",
      `Selector "${params.selector}" tidak dikenali. Contoh: "pasal 1266", "pasal 1266-1267", "pasal 5, 7-9", "bab III", "penjelasan pasal 5", "menimbang", "outline".`,
    );
  }
  const maxChars = Math.min(READ_MAX_CHARS, Math.max(READ_MIN_CHARS, Math.trunc(params.maxChars ?? READ_DEFAULT_CHARS) || READ_DEFAULT_CHARS));
  const meta = await loadNodeMeta(db, regulation.id);
  if (!meta.ok) return meta;
  const nodes = meta.data;
  const summary = summarizeRegulation(regulation);

  if (selector.kind === "outline") {
    const structural = nodes.filter((n) => STRUCTURAL_TYPES.includes(n.node_type));
    const pasal = nodes.filter((n) => n.node_type === "pasal");
    const outline = structural.map((s, idx) => {
      const nextStart = structural[idx + 1]?.sort_order ?? Number.POSITIVE_INFINITY;
      const inside = pasal.filter((p) => p.sort_order > s.sort_order && p.sort_order < nextStart);
      return {
        node_type: s.node_type,
        number: s.number,
        heading: s.heading,
        context: s.context,
        pasal_from: inside[0]?.number ?? null,
        pasal_to: inside[inside.length - 1]?.number ?? null,
      };
    });
    const note = `${pasal.length} pasal${pasal.length ? ` (Pasal ${pasal[0].number} – Pasal ${pasal[pasal.length - 1].number})` : ""}; ${nodes.filter((n) => n.node_type === "penjelasan").length} penjelasan.`;
    return ok({ regulation: summary, selector: params.selector, outline, sections: [], total_chars: 0, truncated: false, missing: [], note });
  }

  let chosen: NodeMeta[] = [];
  const missing: string[] = [];
  if (selector.kind === "preamble") {
    chosen = nodes.filter((n) => n.node_type === "preamble");
    if (!chosen.length) missing.push("pembukaan");
  } else if (selector.kind === "all") {
    chosen = nodes.filter((n) => n.node_type === "pasal" || n.node_type === "content");
  } else if (selector.kind === "bab") {
    const babNode = nodes.find((n) => n.node_type === "bab" && romanOrNumber(n.number ?? "") === selector.number);
    if (!babNode) {
      missing.push(`BAB ${selector.number}`);
    } else {
      const nextBab = nodes.find((n) => (n.node_type === "bab" || n.node_type === "buku") && n.sort_order > babNode.sort_order);
      const end = nextBab?.sort_order ?? Number.POSITIVE_INFINITY;
      chosen = nodes.filter((n) => n.node_type === "pasal" && n.sort_order > babNode.sort_order && n.sort_order < end);
    }
  } else {
    const type = selector.kind === "penjelasan" ? "penjelasan" : "pasal";
    const pool = nodes.filter((n) => n.node_type === type);
    if (selector.kind === "penjelasan" && selector.numbers === null) {
      chosen = pool;
    } else {
      const wanted = new Set((selector.kind === "penjelasan" ? selector.numbers ?? [] : selector.numbers).map((n) => n.toUpperCase()));
      const ranges = selector.kind === "pasal" ? selector.ranges : [];
      chosen = pool.filter((n) => {
        const num = (n.number ?? "").toUpperCase();
        if (wanted.has(num)) return true;
        const k = pasalNumeric(n.number);
        return ranges.some(([a, b]) => k >= a && k <= b);
      });
      for (const w of wanted) if (!pool.some((n) => (n.number ?? "").toUpperCase() === w)) missing.push(`${type === "penjelasan" ? "Penjelasan " : ""}Pasal ${w}`);
      for (const [a, b] of ranges) if (!pool.some((n) => { const k = pasalNumeric(n.number); return k >= a && k <= b; })) missing.push(`Pasal ${a}-${b}`);
    }
  }

  const content = await loadNodeContent(db, chosen.map((n) => n.id));
  if (!content.ok) return content;
  const sections: RegulationReadResult["sections"] = [];
  let total = 0;
  let truncated = false;
  for (const n of content.data) {
    const text = n.content;
    if (total + text.length > maxChars) {
      const room = maxChars - total;
      if (room > 200) {
        sections.push({ node_type: n.node_type, number: n.number, heading: n.heading, context: n.context, citation: citationFor(regulation.short_name, n.node_type, n.number), content: `${text.slice(0, room)}…` });
        total += room;
      }
      truncated = true;
      break;
    }
    sections.push({ node_type: n.node_type, number: n.number, heading: n.heading, context: n.context, citation: citationFor(regulation.short_name, n.node_type, n.number), content: text });
    total += text.length;
  }
  return ok({
    regulation: summary,
    selector: params.selector,
    sections,
    total_chars: total,
    truncated,
    missing,
    ...(truncated ? { note: `Dipotong pada ${maxChars} karakter; minta rentang pasal yang lebih sempit.` } : {}),
  });
}
