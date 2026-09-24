// Parser for Indonesian regulation text (UU, PP, Permen, Perda, the civil code)
// into a flat list of nodes: structural headings (BUKU / BAB / Bagian /
// Paragraf), articles (Pasal), the elucidation (Penjelasan), the preamble, and
// fallback text chunks when a document has no Pasal structure at all.
//
// Pure and deterministic; the regulations module stores the result in
// regulation_nodes. The input is whatever the PDF/DOCX extractor produced, so
// the parser is defensive about page markers, page numbers and line wraps.
// The one rule that matters most: a "Pasal N" line is a heading only when it
// stands alone (or carries its text after a colon/period) AND continues the
// article sequence, because a wrapped cross-reference ("sebagaimana dimaksud
// dalam\nPasal 5 ayat (1)") lands "Pasal 5" at a line start too.

export type RegulationNodeType =
    | "buku"
    | "bab"
    | "bagian"
    | "paragraf"
    | "pasal"
    | "penjelasan"
    | "preamble"
    | "content";

export type ParsedRegulationNode = {
    node_type: RegulationNodeType;
    number: string | null;
    heading: string | null;
    /** Heading chain above the node, e.g. "BUKU KETIGA Perikatan › BAB IV › Bagian Kedua". */
    context: string | null;
    content: string;
    sort_order: number;
};

export type ParsedRegulation = {
    nodes: ParsedRegulationNode[];
    warnings: string[];
    stats: { pasal: number; penjelasan: number; structural: number; content_chunks: number };
};

const STRUCTURAL_LABEL: Record<"buku" | "bab" | "bagian" | "paragraf", string> = {
    buku: "BUKU",
    bab: "BAB",
    bagian: "Bagian",
    paragraf: "Paragraf",
};
const STRUCTURAL_RANK: Record<"buku" | "bab" | "bagian" | "paragraf", number> = {
    buku: 0,
    bab: 1,
    bagian: 2,
    paragraf: 3,
};

const PAGE_MARKER_RE = /^\[Page \d+(?: form fields)?\]\s*$/;
const PAGE_NUMBER_RE = /^\s*(?:-\s*)?\d{1,4}(?:\s*-)?\s*$/;
const URL_LINE_RE = /^\S*(?:www\.|https?:\/\/)\S*$/i;

const BUKU_RE = /^BUKU\s+(KE[A-Z]+|[IVXLC]+|\d+)\b\s*(.*)$/i;
const BAB_RE = /^BAB\s+([IVXLC]+|\d+)\b\s*(.*)$/;
const BAGIAN_RE = /^Bagian\s+(Ke[a-z]+|\d+)\b\s*(.*)$/i;
const PARAGRAF_RE = /^Paragraf\s+(\d+)\b\s*(.*)$/i;
const PASAL_ALONE_RE = /^Pasal\s+(\d+)\s*([A-Z])?\s*\.?\s*$/;
const PASAL_INLINE_RE = /^Pasal\s+(\d+)\s*([A-Z])?\s*[.:]\s+(\S.*)$/;
const PENJELASAN_RE = /^PENJELASAN\b/;
const LAMPIRAN_RE = /^LAMPIRAN\b/;
const PENJELASAN_UMUM_RE = /^I\.\s*UMUM\b/;
const PENJELASAN_PASAL_DEMI_PASAL_RE = /^II\.\s*PASAL\s+DEMI\s+PASAL\b/;

export const CONTENT_CHUNK_CHARS = 1500;

/** Strip extractor artefacts: page markers, lone page numbers, URL-only footer lines. */
export function cleanExtractedText(raw: string): string {
    const lines = raw.replace(/\r/g, "").split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        const t = line.replace(/\s+$/, "");
        if (PAGE_MARKER_RE.test(t)) continue;
        if (PAGE_NUMBER_RE.test(t)) continue;
        if (URL_LINE_RE.test(t.trim())) continue;
        kept.push(t);
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeBlock(lines: string[]): string {
    return lines
        .map((l) => l.trim())
        .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
        .join("\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function pasalKey(num: number, suffix: string): number {
    // "5" < "5A" < "5B" < "6"
    return num * 100 + (suffix ? suffix.charCodeAt(0) - 64 : 0);
}

function isUpperTitle(line: string): boolean {
    const letters = line.replace(/[^A-Za-z]/g, "");
    return letters.length >= 3 && letters === letters.toUpperCase();
}

function isShortTitle(line: string): boolean {
    const t = line.trim();
    return t.length > 0 && t.length <= 110 && !/[.;:]$/.test(t) && /[A-Za-z]/.test(t);
}

function isAnyHeading(t: string): boolean {
    return (
        BUKU_RE.test(t) ||
        BAB_RE.test(t) ||
        BAGIAN_RE.test(t) ||
        PARAGRAF_RE.test(t) ||
        PASAL_ALONE_RE.test(t) ||
        PASAL_INLINE_RE.test(t) ||
        PENJELASAN_RE.test(t) ||
        LAMPIRAN_RE.test(t)
    );
}

type Structural = { type: "buku" | "bab" | "bagian" | "paragraf"; number: string; heading: string };

function contextOf(stack: Structural[]): string | null {
    if (stack.length === 0) return null;
    return stack
        .map((s) => {
            const label = `${STRUCTURAL_LABEL[s.type]} ${s.number}${s.heading ? ` ${s.heading}` : ""}`;
            return label.length > 90 ? `${label.slice(0, 87)}…` : label;
        })
        .join(" › ");
}

export function chunkText(text: string, size = CONTENT_CHUNK_CHARS): string[] {
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const p of paragraphs) {
        if (current && current.length + p.length + 2 > size) {
            chunks.push(current);
            current = "";
        }
        if (p.length > size) {
            if (current) chunks.push(current);
            current = "";
            for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
            continue;
        }
        current = current ? `${current}\n\n${p}` : p;
    }
    if (current) chunks.push(current);
    return chunks;
}

type ArticleCandidate = { line: number; key: number; label: string };

/**
 * Indices of the longest strictly increasing run of keys (patience sorting,
 * O(n log n)). Chosen over "must exceed the previous heading" because one
 * stray forward reference wrapped onto its own line ("tanpa mengurangi
 * ketentuan\nPasal 1341.") would otherwise be taken as an article and cause
 * every real article up to 1340 to be rejected as out of sequence.
 */
export function longestIncreasingRun(keys: number[]): number[] {
    const tails: number[] = []; // index into keys of the smallest tail per length
    const prev: number[] = new Array(keys.length).fill(-1);
    for (let i = 0; i < keys.length; i += 1) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (keys[tails[mid]] < keys[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
    }
    const out: number[] = [];
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(k);
    return out.reverse();
}

type ArticlePlan = {
    accepted: Set<number>;
    rejected: ArticleCandidate[];
    penjelasanStart: number | null;
    lampiranStart: number | null;
};

/**
 * First pass: find the section boundaries (PENJELASAN, LAMPIRAN) and every
 * line shaped like an article heading, then keep, per section, the longest
 * increasing run of article numbers. The main pass opens an article only on
 * an accepted line.
 */
function planArticles(lines: string[]): ArticlePlan {
    const bySection: Record<"body" | "penjelasan", ArticleCandidate[]> = { body: [], penjelasan: [] };
    let section: "body" | "penjelasan" = "body";
    let penjelasanStart: number | null = null;
    let lampiranStart: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (LAMPIRAN_RE.test(t) && (bySection.body.length > 0 || section === "penjelasan")) {
            lampiranStart = i;
            break;
        }
        if (section === "body" && PENJELASAN_RE.test(t) && bySection.body.length > 0) {
            penjelasanStart = i;
            section = "penjelasan";
            continue;
        }
        const pm = PASAL_ALONE_RE.exec(t) ?? PASAL_INLINE_RE.exec(t);
        if (!pm) continue;
        const suffix = pm[2] ?? "";
        bySection[section].push({ line: i, key: pasalKey(Number(pm[1]), suffix), label: `Pasal ${pm[1]}${suffix}` });
    }
    const accepted = new Set<number>();
    const rejected: ArticleCandidate[] = [];
    for (const candidates of Object.values(bySection)) {
        const keep = new Set(longestIncreasingRun(candidates.map((c) => c.key)));
        candidates.forEach((c, idx) => (keep.has(idx) ? accepted.add(c.line) : rejected.push(c)));
    }
    return { accepted, rejected, penjelasanStart, lampiranStart };
}

export function parseRegulationText(raw: string): ParsedRegulation {
    const text = cleanExtractedText(raw);
    const lines = text.split("\n");
    const warnings: string[] = [];
    const nodes: ParsedRegulationNode[] = [];
    let sortOrder = 0;
    const push = (node: Omit<ParsedRegulationNode, "sort_order">) => {
        nodes.push({ ...node, sort_order: sortOrder++ });
    };

    type Section = "body" | "penjelasan" | "lampiran";
    let section: Section = "body";
    const stack: Structural[] = [];
    let preamble: string[] = [];
    let preambleClosed = false;
    let pasal: { number: string; lines: string[]; context: string | null } | null = null;
    let penjelasanUmum: string[] = [];
    let penjelasanUmumOpen = false;
    // The capitalised title lines right after "PENJELASAN" ("ATAS PERATURAN
    // MENTERI ... NOMOR ..."), which belong to no section.
    let penjelasanHeader = false;
    let lampiran: string[] = [];
    const plan = planArticles(lines);
    for (const r of plan.rejected) warnings.push(`line ${r.line + 1}: "${r.label}" out of sequence, kept as text`);
    let pasalCount = 0;
    let penjelasanCount = 0;
    let structuralCount = 0;

    const closePasal = () => {
        if (!pasal) return;
        const content = normalizeBlock(pasal.lines);
        if (section === "penjelasan") {
            push({ node_type: "penjelasan", number: pasal.number, heading: `Penjelasan Pasal ${pasal.number}`, context: null, content });
            penjelasanCount += 1;
        } else {
            push({ node_type: "pasal", number: pasal.number, heading: `Pasal ${pasal.number}`, context: pasal.context, content });
            pasalCount += 1;
        }
        pasal = null;
    };
    const closePreamble = () => {
        if (preambleClosed) return;
        preambleClosed = true;
        const content = normalizeBlock(preamble);
        if (content) push({ node_type: "preamble", number: null, heading: "Pembukaan", context: null, content });
        preamble = [];
    };
    const closePenjelasanUmum = () => {
        if (!penjelasanUmumOpen) return;
        penjelasanUmumOpen = false;
        const content = normalizeBlock(penjelasanUmum);
        if (content) {
            push({ node_type: "penjelasan", number: "UMUM", heading: "Penjelasan Umum", context: null, content });
            penjelasanCount += 1;
        }
        penjelasanUmum = [];
    };
    const openStructural = (type: Structural["type"], number: string, heading: string) => {
        closePasal();
        closePreamble();
        while (stack.length && STRUCTURAL_RANK[stack[stack.length - 1].type] >= STRUCTURAL_RANK[type]) stack.pop();
        const node: Structural = { type, number, heading };
        stack.push(node);
        push({
            node_type: type,
            number,
            heading: heading || null,
            context: contextOf(stack.slice(0, -1)),
            content: heading,
        });
        structuralCount += 1;
    };

    /** Title lines that follow a structural heading on their own lines. */
    const collectTitle = (i: number, type: Structural["type"]): { heading: string; next: number } => {
        const parts: string[] = [];
        let j = i + 1;
        const maxLines = type === "buku" || type === "bab" ? 3 : 2;
        while (j < lines.length && parts.length < maxLines) {
            const t = lines[j].trim();
            if (!t) {
                if (parts.length) break;
                j += 1;
                continue;
            }
            if (isAnyHeading(t)) break;
            const ok = type === "buku" || type === "bab" ? isUpperTitle(t) : isShortTitle(t);
            if (!ok) break;
            parts.push(t);
            j += 1;
        }
        return { heading: parts.join(" "), next: j };
    };

    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();

        if (section === "lampiran") {
            lampiran.push(lines[i]);
            continue;
        }

        if (i === plan.lampiranStart) {
            closePasal();
            closePenjelasanUmum();
            section = "lampiran";
            lampiran.push(lines[i]);
            continue;
        }

        if (i === plan.penjelasanStart) {
            closePasal();
            section = "penjelasan";
            penjelasanUmumOpen = true;
            penjelasanHeader = true;
            continue;
        }

        if (section === "penjelasan") {
            if (penjelasanHeader) {
                if (!t) continue;
                if (isUpperTitle(t) && !PASAL_ALONE_RE.test(t) && !PASAL_INLINE_RE.test(t) && !PENJELASAN_UMUM_RE.test(t)) continue;
                penjelasanHeader = false;
            }
            if (PENJELASAN_UMUM_RE.test(t)) continue;
            if (PENJELASAN_PASAL_DEMI_PASAL_RE.test(t)) {
                closePenjelasanUmum();
                continue;
            }
        }

        let m: RegExpMatchArray | null;
        if (section === "body") {
            if ((m = BUKU_RE.exec(t)) && isUpperTitle(t)) {
                const inline = m[2].trim();
                const { heading, next } = inline ? { heading: inline, next: i + 1 } : collectTitle(i, "buku");
                openStructural("buku", m[1].toUpperCase(), heading);
                i = next - 1;
                continue;
            }
            if ((m = BAB_RE.exec(t))) {
                const inline = m[2].trim();
                const { heading, next } = inline ? { heading: inline, next: i + 1 } : collectTitle(i, "bab");
                openStructural("bab", m[1], heading);
                i = next - 1;
                continue;
            }
            if ((m = BAGIAN_RE.exec(t)) && pasalCount + structuralCount > 0) {
                const inline = m[2].trim();
                const { heading, next } = inline ? { heading: inline, next: i + 1 } : collectTitle(i, "bagian");
                openStructural("bagian", m[1], heading);
                i = next - 1;
                continue;
            }
            if ((m = PARAGRAF_RE.exec(t)) && stack.length > 0) {
                const inline = m[2].trim();
                const { heading, next } = inline ? { heading: inline, next: i + 1 } : collectTitle(i, "paragraf");
                openStructural("paragraf", m[1], heading);
                i = next - 1;
                continue;
            }
        }

        const alone = PASAL_ALONE_RE.exec(t);
        const inline = alone ? null : PASAL_INLINE_RE.exec(t);
        const pm = alone ?? inline;
        if (pm && plan.accepted.has(i)) {
            closePasal();
            closePreamble();
            closePenjelasanUmum();
            pasal = { number: `${Number(pm[1])}${pm[2] ?? ""}`, lines: [], context: contextOf(stack) };
            if (inline) pasal.lines.push(inline[3]);
            continue;
        }

        if (pasal) {
            pasal.lines.push(lines[i]);
        } else if (section === "penjelasan") {
            penjelasanUmum.push(lines[i]);
        } else if (!preambleClosed) {
            preamble.push(lines[i]);
        } else {
            // Body text between headings with no open article: attach to the
            // structural node's content so it is not lost.
            const last = nodes[nodes.length - 1];
            if (last && t) last.content = last.content ? `${last.content}\n${t}` : t;
        }
    }
    closePasal();
    closePenjelasanUmum();

    let contentChunks = 0;
    if (section === "lampiran") {
        const chunks = chunkText(normalizeBlock(lampiran));
        chunks.forEach((chunk, idx) => {
            push({ node_type: "content", number: String(idx + 1), heading: "Lampiran", context: null, content: chunk });
        });
        contentChunks += chunks.length;
    }

    if (pasalCount === 0) {
        // No article structure at all: keep the text searchable as chunks.
        warnings.push("no Pasal structure detected; stored as text chunks");
        nodes.length = 0;
        sortOrder = 0;
        const chunks = chunkText(text);
        chunks.forEach((chunk, idx) => {
            push({ node_type: "content", number: String(idx + 1), heading: null, context: null, content: chunk });
        });
        contentChunks = chunks.length;
        structuralCount = 0;
        penjelasanCount = 0;
    } else {
        if (!preambleClosed) closePreamble();
        // Numbering gaps usually mean a heading missing from the source's text
        // layer (its article's text then sits in the previous article) or an
        // article repealed and omitted. Either way a reviewer should know.
        const numbers = nodes.filter((n) => n.node_type === "pasal").map((n) => Number(/^\d+/.exec(n.number ?? "")?.[0]));
        const gaps: string[] = [];
        for (let k = 1; k < numbers.length; k += 1) {
            if (numbers[k] - numbers[k - 1] > 1) gaps.push(`${numbers[k - 1]}→${numbers[k]}`);
        }
        if (gaps.length) {
            warnings.push(
                `article numbering skips at ${gaps.slice(0, 20).join(", ")}${gaps.length > 20 ? ` (+${gaps.length - 20} more)` : ""}: headings missing from the source text, or articles omitted`,
            );
        }
    }

    return {
        nodes,
        warnings,
        stats: { pasal: pasalCount, penjelasan: penjelasanCount, structural: structuralCount, content_chunks: contentChunks },
    };
}
