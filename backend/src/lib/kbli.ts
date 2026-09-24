// KBLI (Klasifikasi Baku Lapangan Usaha Indonesia) lookup over the bundled
// dataset in backend/data/kbli/kbli-2025.json, built by
// scripts/build-kbli-dataset.ts from the annex of Peraturan BPS No. 6 Tahun
// 2026 (the consolidated KBLI 2025). Pasal.id can only page that annex as one
// long text, so code lookups live here, in memory, with no network.
//
// Two entry points: by code (exact definition, parent chain, children,
// siblings) and by free-text query in Indonesian (ranked candidates). Both are
// deliberately simple: the model reads the returned "mencakup / tidak
// mencakup" text and does the classification reasoning itself.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KbliDataset, KbliEntry, KbliLevel, KbliSource } from "./kbliParse";

// src/lib and dist/lib are both two levels below backend/, so one relative
// path serves tsx in dev, node in prod and vitest.
export const KBLI_DATASET_PATH = resolve(__dirname, "../../data/kbli/kbli-2025.json");

export const KBLI_DEFAULT_LIMIT = 8;
export const KBLI_MAX_LIMIT = 20;
const DESCRIPTION_CHARS_FULL = 2_000;
const DESCRIPTION_CHARS_MATCH = 700;
const MAX_CHILDREN = 60;

export type KbliIndex = {
    source: KbliSource;
    byCode: Map<string, KbliEntry>;
    children: Map<string, KbliEntry[]>;
    docs: SearchDoc[];
};

type SearchDoc = {
    entry: KbliEntry;
    titleTokens: string[];
    descTokens: Set<string>;
};

export type KbliRef = { code: string; level: KbliLevel; title: string };

export type KbliCodeResult = {
    found: boolean;
    code: string;
    entry?: KbliRef & { description: string; parent: string | null };
    ancestors: KbliRef[];
    children: KbliRef[];
    siblings: KbliRef[];
    /** When the code is unknown: the closest existing ancestor by prefix. */
    nearest?: KbliRef;
};

export type KbliMatch = KbliRef & {
    score: number;
    ancestors: KbliRef[];
    description: string;
};

export type KbliLookupResult = {
    source: { regulation: string; edition: string; url: string };
    code?: KbliCodeResult;
    query?: { text: string; matches: KbliMatch[] };
    guidance: string[];
};

let cachedIndex: KbliIndex | null | undefined;

/** Whether the bundled dataset is present; gates the tool and its prompt. */
export function kbliAvailable(): boolean {
    return getKbliIndex() !== null;
}

export function getKbliIndex(): KbliIndex | null {
    if (cachedIndex !== undefined) return cachedIndex;
    if (!existsSync(KBLI_DATASET_PATH)) {
        cachedIndex = null;
        return cachedIndex;
    }
    try {
        const dataset = JSON.parse(readFileSync(KBLI_DATASET_PATH, "utf8")) as KbliDataset;
        cachedIndex = buildKbliIndex(dataset);
    } catch (err) {
        console.error("[kbli] failed to load dataset", err);
        cachedIndex = null;
    }
    return cachedIndex;
}

export function buildKbliIndex(dataset: KbliDataset): KbliIndex {
    const byCode = new Map<string, KbliEntry>();
    const children = new Map<string, KbliEntry[]>();
    const docs: SearchDoc[] = [];
    for (const entry of dataset.entries) {
        byCode.set(entry.code, entry);
        if (entry.parent) {
            const list = children.get(entry.parent) ?? [];
            list.push(entry);
            children.set(entry.parent, list);
        }
        docs.push({
            entry,
            titleTokens: tokenize(entry.title),
            descTokens: new Set(tokenize(coveredPart(entry.description))),
        });
    }
    return { source: dataset.source, byCode, children, docs };
}

// ── Text handling ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
    "dan", "atau", "untuk", "yang", "dengan", "dari", "di", "ke", "pada", "oleh", "serta", "bagi",
    "dalam", "sebagai", "adalah", "ini", "itu", "juga", "lainnya", "lain", "kegiatan", "aktivitas",
    "usaha", "jasa", "kbli", "kode", "the", "of", "and", "for", "a", "an",
]);

// Descriptions end with what the code does NOT cover ("Kelompok ini tidak
// mencakup angkutan barang berbahaya, lihat kelompok 49232"). Indexing that
// part would rank a code for the very activity it excludes, so only the
// covering part is searchable. The model still sees the full text.
const EXCLUSION_RE = /\b(?:tidak|bukan)\s+(?:mencakup|termasuk|meliputi)\b/i;

export function coveredPart(description: string): string {
    const idx = description.search(EXCLUSION_RE);
    return idx >= 0 ? description.slice(0, idx) : description;
}

export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((t) => t.length >= 2);
}

function queryTokens(text: string): string[] {
    return Array.from(new Set(tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length >= 3)));
}

/** "angkut" matches "angkutan"; "pengangkutan" matches "angkutan" only via its own stem, so keep it literal. */
function tokenMatches(query: string, token: string): boolean {
    if (token === query) return true;
    if (token.startsWith(query) && query.length >= 4) return true;
    if (query.startsWith(token) && token.length >= 5) return true;
    return false;
}

function anyMatch(query: string, tokens: Iterable<string>): boolean {
    for (const t of tokens) if (tokenMatches(query, t)) return true;
    return false;
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

function ref(entry: KbliEntry): KbliRef {
    return { code: entry.code, level: entry.level, title: entry.title };
}

// ── Lookups ────────────────────────────────────────────────────────────────

export function normalizeKbliCode(raw: string): string {
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return cleaned;
}

export function ancestorsOf(index: KbliIndex, entry: KbliEntry): KbliRef[] {
    const chain: KbliRef[] = [];
    let parent = entry.parent;
    while (parent) {
        const p = index.byCode.get(parent);
        if (!p) break;
        chain.unshift(ref(p));
        parent = p.parent;
    }
    return chain;
}

export function lookupKbliCode(index: KbliIndex, rawCode: string): KbliCodeResult {
    const code = normalizeKbliCode(rawCode);
    const entry = index.byCode.get(code);
    if (entry) {
        const childList = (index.children.get(code) ?? []).slice(0, MAX_CHILDREN).map(ref);
        const siblings =
            entry.parent && entry.level === "kelompok"
                ? (index.children.get(entry.parent) ?? []).filter((e) => e.code !== code).map(ref)
                : [];
        return {
            found: true,
            code,
            entry: { ...ref(entry), description: clip(entry.description, DESCRIPTION_CHARS_FULL), parent: entry.parent },
            ancestors: ancestorsOf(index, entry),
            children: childList,
            siblings,
        };
    }
    // Unknown code (often a KBLI 2020 number): walk up the prefixes.
    let nearest: KbliEntry | undefined;
    for (let len = Math.min(code.length - 1, 4); len >= 2 && !nearest; len -= 1) {
        nearest = index.byCode.get(code.slice(0, len));
    }
    return {
        found: false,
        code,
        ancestors: nearest ? [...ancestorsOf(index, nearest), ref(nearest)] : [],
        children: nearest ? (index.children.get(nearest.code) ?? []).slice(0, MAX_CHILDREN).map(ref) : [],
        siblings: [],
        ...(nearest ? { nearest: ref(nearest) } : {}),
    };
}

export function searchKbli(index: KbliIndex, text: string, limit = KBLI_DEFAULT_LIMIT): KbliMatch[] {
    const terms = queryTokens(text);
    if (terms.length === 0) return [];
    const scored: { doc: SearchDoc; score: number }[] = [];
    for (const doc of index.docs) {
        let score = 0;
        let hits = 0;
        for (const term of terms) {
            const inTitle = anyMatch(term, doc.titleTokens);
            const inDesc = inTitle || anyMatch(term, doc.descTokens);
            if (inTitle) score += 3;
            else if (inDesc) score += 1;
            if (inDesc) hits += 1;
        }
        if (hits === 0) continue;
        if (hits === terms.length) score += 2;
        // Five-digit codes are what a business registers; rank them first.
        if (doc.entry.level === "kelompok") score += 1;
        else if (doc.entry.level === "subgolongan") score += 0.5;
        scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score || a.doc.entry.code.localeCompare(b.doc.entry.code));
    return scored.slice(0, limit).map(({ doc, score }) => ({
        ...ref(doc.entry),
        score,
        ancestors: ancestorsOf(index, doc.entry),
        description: clip(doc.entry.description, DESCRIPTION_CHARS_MATCH),
    }));
}

export function lookupKbli(
    params: { code?: string; query?: string; limit?: number },
    index: KbliIndex | null = getKbliIndex(),
): KbliLookupResult | { error: string } {
    if (!index) return { error: "KBLI dataset is not available on this server." };
    const code = params.code?.trim();
    const query = params.query?.trim();
    if (!code && !query) return { error: "Provide a KBLI code, a query, or both." };
    const limit = Math.min(KBLI_MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? KBLI_DEFAULT_LIMIT) || KBLI_DEFAULT_LIMIT));

    const result: KbliLookupResult = {
        source: { regulation: index.source.regulation, edition: index.source.edition, url: index.source.url },
        guidance: [],
    };
    if (code) {
        result.code = lookupKbliCode(index, code);
        if (!result.code.found) {
            result.guidance.push(
                `Code ${result.code.code} is not in KBLI 2025. KBLI 2025 renumbered several codes; a KBLI 2020 code may have moved. Search by activity (query) to find the current code${result.code.nearest ? `, or inspect the children of ${result.code.nearest.code}` : ""}.`,
            );
        } else if (result.code.entry?.level !== "kelompok") {
            result.guidance.push("This is a grouping level; businesses register a five-digit kelompok. See children.");
        }
    }
    if (query) {
        const matches = searchKbli(index, query, limit);
        result.query = { text: query, matches };
        if (matches.length === 0) {
            result.guidance.push("No entry matched. Rephrase in Indonesian with the activity's own vocabulary (e.g. 'angkutan barang', 'pergudangan', 'perdagangan besar').");
        } else {
            result.guidance.push("Read 'mencakup' and 'tidak mencakup' before choosing; follow any 'lihat kelompok NNNNN' pointer with a code lookup.");
        }
    }
    result.guidance.push("Classification only: licensing consequences (risk level, permits) are set by PP 28/2025 and OSS, not by this table.");
    return result;
}
