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
  return matchRegulationRef(listed.data, ref);
}

/** Pure half of resolveRegulationRef, over an already loaded catalog. */
export function matchRegulationRef(
  rows: RegulationRow[],
  ref: string,
): ServiceResult<{ regulation: RegulationRow; candidates: RegulationSummary[] }> {
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
  /**
   * How the hits were found: "citation" (an exact article named in the
   * query), "all" (every word matched), "any" (fallback: some words matched,
   * weaker evidence), or "none".
   */
  match: "citation" | "all" | "any" | "none";
  /** The regulation the search was narrowed to, when the query named one. */
  regulation_filter: string | null;
  hits: RegulationSearchHit[];
  /** The catalog, inline when small, so the model knows what the library holds. */
  library: RegulationSummary[] | { count: number };
};

/**
 * A regex matching a short name however it is typed: "KUHPerdata",
 * "KUH Perdata", "kuh-perdata"; "PM 60/2019", "pm 60 2019". Null for names
 * too short to spot safely inside free text.
 */
function shortNamePattern(shortName: string): RegExp | null {
  const chars = norm(shortName).replace(/\s+/g, "");
  if (chars.length < 4) return null;
  const body = chars.split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\W_]*");
  return new RegExp(`(?:^|[^a-z0-9])(${body})(?=$|[^a-z0-9])`, "i");
}

/** The first visible regulation whose short name appears in the query, and the query without it. */
export function detectRegulationMention(rows: RegulationRow[], query: string): { regulation: RegulationRow; rest: string } | null {
  // Longest names first, so "PM 60/2019" wins over a hypothetical "PM 60".
  const sorted = [...rows].sort((a, b) => b.short_name.length - a.short_name.length);
  for (const row of sorted) {
    const re = shortNamePattern(row.short_name);
    const m = re ? re.exec(query) : null;
    if (m && m.index !== undefined) {
      const start = m.index + m[0].indexOf(m[1]);
      return { regulation: row, rest: `${query.slice(0, start)} ${query.slice(start + m[1].length)}`.replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

const CITATION_RE = /\bpasal\s+(\d+)\s*([a-z])?\b/i;

function hitFromRow(r: Record<string, unknown>, shortName: string, rest: Partial<RegulationSearchHit["regulation"]> = {}): RegulationSearchHit {
  return {
    regulation: {
      id: String(r.regulation_id),
      short_name: shortName,
      title: String(r.title ?? rest.title ?? ""),
      status: String(r.status ?? rest.status ?? ""),
      regulation_type: String(r.regulation_type ?? rest.regulation_type ?? ""),
      issuer: (r.issuer as string | null) ?? rest.issuer ?? null,
    },
    node_type: String(r.node_type),
    number: (r.number as string | null) ?? null,
    heading: (r.heading as string | null) ?? null,
    context: (r.context as string | null) ?? null,
    snippet: String(r.snippet ?? ""),
    citation: citationFor(shortName, String(r.node_type), (r.number as string | null) ?? null),
  };
}

/** Words for the "any word" fallback: websearch syntax joins them with "or". */
function anyWordQuery(text: string): string | null {
  const words = Array.from(new Set(norm(text).split(" ").filter((w) => w.length >= 3 && !/^\d+$/.test(w))));
  return words.length >= 2 ? words.join(" or ") : null;
}

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
  const listed = await listRegulations(db, scope);
  if (!listed.ok) return listed;
  const rows = listed.data;
  const library = rows.length <= CATALOG_INLINE_MAX ? rows.map(summarizeRegulation) : { count: rows.length };

  // Narrow to one regulation: explicitly, or because the query names it
  // ("Pasal 1266 KUHPerdata"). The name is then dropped from the text query,
  // since it never occurs inside the articles themselves.
  let target: RegulationRow | null = null;
  let text = query;
  if (params.regulation?.trim()) {
    const resolved = matchRegulationRef(rows, params.regulation);
    if (!resolved.ok) return resolved;
    target = resolved.data.regulation;
  } else {
    const mention = detectRegulationMention(rows, query);
    if (mention) {
      target = mention.regulation;
      text = mention.rest;
    }
  }
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT));
  const base = { query, regulation_filter: target?.short_name ?? null, library };

  // An exact citation into a known regulation is answered directly.
  const cite = CITATION_RE.exec(text);
  if (cite && target) {
    const number = `${cite[1]}${(cite[2] ?? "").toUpperCase()}`;
    const { data, error } = await db
      .from("regulation_nodes")
      .select("id, regulation_id, node_type, number, heading, context, content")
      .eq("regulation_id", target.id)
      .eq("node_type", "pasal")
      .eq("number", number)
      .maybeSingle();
    if (error) return internalFailure(error);
    if (data) {
      const node = data as Record<string, unknown>;
      const hit = hitFromRow({ ...node, snippet: clipText(String(node.content ?? ""), 400) }, target.short_name, target);
      return ok({ ...base, match: "citation", hits: [hit] });
    }
  }

  const runSearch = async (q: string) =>
    db.rpc("search_regulation_nodes", {
      p_org_ids: scope.orgIds,
      p_query: q,
      p_regulation_id: target?.id ?? null,
      p_limit: limit,
    });
  const toHits = (data: unknown) =>
    ((data ?? []) as Record<string, unknown>[]).map((r) => hitFromRow(r, String(r.short_name ?? "")));

  const searchText = text.trim() || query;
  const all = await runSearch(searchText);
  if (all.error) return internalFailure(all.error);
  const allHits = toHits(all.data);
  if (allHits.length > 0) return ok({ ...base, match: "all", hits: allHits });

  const anyQuery = anyWordQuery(searchText);
  if (anyQuery) {
    const any = await runSearch(anyQuery);
    if (any.error) return internalFailure(any.error);
    const anyHits = toHits(any.data);
    if (anyHits.length > 0) return ok({ ...base, match: "any", hits: anyHits });
  }
  return ok({ ...base, match: "none", hits: [] });
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
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

/**
 * PostgREST caps a response at its max-rows setting (1,000 on Supabase), and
 * a civil code has over 2,000 nodes, so metadata is read page by page.
 */
export const NODE_PAGE_SIZE = 1000;
/** Ids per content request: keeps the `in.(…)` filter well inside URL limits. */
export const CONTENT_BATCH_SIZE = 150;

async function loadNodeMeta(db: Db, regulationId: string): Promise<ServiceResult<NodeMeta[]>> {
  const out: NodeMeta[] = [];
  for (let from = 0; ; from += NODE_PAGE_SIZE) {
    const { data, error } = await db
      .from("regulation_nodes")
      .select("id, node_type, number, heading, context, sort_order")
      .eq("regulation_id", regulationId)
      .order("sort_order", { ascending: true })
      .range(from, from + NODE_PAGE_SIZE - 1);
    if (error) return internalFailure(error);
    const page = (data ?? []) as NodeMeta[];
    out.push(...page);
    if (page.length < NODE_PAGE_SIZE) break;
  }
  return ok(out);
}

/**
 * Content for the chosen nodes, in order, loading batch by batch and stopping
 * once `budget` characters are in hand (the caller truncates anyway).
 */
async function loadNodeContent(db: Db, ids: number[], budget: number): Promise<ServiceResult<RegulationNodeRow[]>> {
  const out: RegulationNodeRow[] = [];
  let chars = 0;
  for (let i = 0; i < ids.length && chars <= budget; i += CONTENT_BATCH_SIZE) {
    const { data, error } = await db
      .from("regulation_nodes")
      .select("id, regulation_id, node_type, number, heading, context, content, sort_order")
      .in("id", ids.slice(i, i + CONTENT_BATCH_SIZE))
      .order("sort_order", { ascending: true });
    if (error) return internalFailure(error);
    for (const row of (data ?? []) as RegulationNodeRow[]) {
      out.push(row);
      chars += row.content.length;
    }
  }
  return ok(out);
}

const STRUCTURAL_RANK: Record<string, number> = { buku: 0, bab: 1, bagian: 2, paragraf: 3 };

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
      // A heading spans everything up to the next heading of the same or a
      // higher level: BAB II covers its Bagian and their articles.
      const next = structural.slice(idx + 1).find((n) => STRUCTURAL_RANK[n.node_type] <= STRUCTURAL_RANK[s.node_type]);
      const nextStart = next?.sort_order ?? Number.POSITIVE_INFINITY;
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

  const content = await loadNodeContent(db, chosen.map((n) => n.id), maxChars);
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
