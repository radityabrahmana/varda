// Parser for the KBLI annex text (Klasifikasi Baku Lapangan Usaha Indonesia)
// as extracted from the regulation PDF. Pure and deterministic; used by
// scripts/build-kbli-dataset.ts to produce data/kbli/kbli-2025.json and by the
// tests that pin its behaviour. Runtime lookups live in ./kbli.ts.
//
// Shape of the text, one entry after another, sometimes mid-line:
//   A PERTANIAN, KEHUTANAN, DAN PERIKANAN Kategori ini mencakup ...
//   01 PERTANIAN TANAMAN, ... Golongan pokok ini mencakup ...
//   011 PERTANIAN TANAMAN SEMUSIM Golongan ini mencakup ...
//   0111 PERTANIAN SEREALIA (BUKAN PADI), ... Subgolongan ini mencakup ...
//   0115 PERTANIAN TEMBAKAU Lihat kelompok 01150.
//   0125 PERTANIAN SAYURAN TAHUNAN, ... - pertanian buah beri, ...
//   01111 PERTANIAN JAGUNG Kelompok ini mencakup ...
// Cross-references inside descriptions ("lihat kelompok 01116") are lowercase
// and never followed by an uppercase title, which is what keeps them from
// being read as new entries.

export type KbliLevel = "kategori" | "golongan_pokok" | "golongan" | "subgolongan" | "kelompok";

export type KbliEntry = {
    code: string;
    level: KbliLevel;
    title: string;
    description: string;
    /** Code of the enclosing entry; the kategori letter for a golongan pokok. */
    parent: string | null;
};

export type KbliSource = {
    regulation: string;
    edition: string;
    pasal_law_id: number;
    url: string;
    fetched_at: string;
};

export type KbliDataset = {
    source: KbliSource;
    entries: KbliEntry[];
    warnings: string[];
};

// An entry is a code followed by its title: the longest run of tokens that
// contain no lowercase letter (so "PERTANIAN SEREALIA (BUKAN PADI), ANEKA
// KACANG" and "BIJI - BIJIAN" both survive), whose first token starts with a
// letter. Requiring that first letter is what keeps "lihat subgolongan 7912.
// 559 PENYEDIAAN AKOMODASI" from being read as code 7912 with title "559 ...":
// the entry is 559.
const ENTRY_RE = /(?:^|\s)([A-U]|\d{2}|\d{3}|\d{4}|\d{5})\s+([A-Z][^\sa-z]*(?:\s+[^\sa-z]+)*)(?=\s|$)/g;

// What a real description opens with. Numbers followed by capitals occur in
// running text too ("SL 11 SHS", "ISCED-P 2011"); those never continue with a
// level word, a cross-reference or a bullet.
const DESCRIPTION_OPENER_RE = /^(?:Kategori|Golongan pokok|Golongan|Subgolongan|Kelompok)\b|^Lihat\b|^-\s/;

export function levelForCode(code: string): KbliLevel | null {
    if (/^[A-U]$/.test(code)) return "kategori";
    switch (code.length) {
        case 2:
            return "golongan_pokok";
        case 3:
            return "golongan";
        case 4:
            return "subgolongan";
        case 5:
            return "kelompok";
        default:
            return null;
    }
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** Titles come out of the PDF with spaced hyphens ("BIJI - BIJIAN"); tidy them. */
function normalizeTitle(title: string): string {
    return normalizeWhitespace(title).replace(/\s+-\s+/g, "-");
}

type Candidate = { code: string; level: KbliLevel; title: string; start: number; bodyStart: number };

function findCandidates(text: string): Candidate[] {
    const out: Candidate[] = [];
    // Highest numeric code accepted so far per code length. The annex lists
    // codes in ascending order, which lets the lenient fallbacks below demand
    // that a candidate continue the sequence.
    const lastNumeric = new Map<number, number>();
    for (const m of text.matchAll(ENTRY_RE)) {
        const code = m[1];
        const level = levelForCode(code);
        if (!level) continue;
        // A trailing lone hyphen is the first bullet of the description, not
        // part of the title ("... KACANG - KACANGAN - pertanian ...").
        const title = m[2].replace(/\s+-$/, "");
        if (!/[A-Z]{3}/.test(title)) continue;
        const start = m.index ?? 0;
        const bodyStart = start + m[0].indexOf(m[2]) + title.length;
        const opener = text.slice(bodyStart, bodyStart + 40).replace(/^\s+/, "");
        const atLineStart = start === 0 || text[start] === "\n" || text[start - 1] === "\n";
        const numeric = /^\d+$/.test(code) ? Number(code) : null;
        const continuesSequence = numeric === null || numeric > (lastNumeric.get(code.length) ?? -1);

        let accept = DESCRIPTION_OPENER_RE.test(opener);
        // A few entries open with an ordinary sentence ("9112 AKTIVITAS
        // KEARSIPAN / Aktivitas kearsipan meliputi ..."), and a couple lost
        // the opening words of their description to the PDF extraction
        // ("49221 ANGKUTAN ANTARKOTA ANTARPROVINSI (AKAP) / satu kota ke kota
        // lain ..."). Both sit at a line start and continue the code sequence;
        // the false matches inside running text do neither.
        if (!accept && atLineStart && continuesSequence) {
            accept = /^[A-Z][a-z]/.test(opener) || (code.length >= 4 && /^[a-z]/.test(opener));
        }
        if (!accept) continue;
        if (numeric !== null) lastNumeric.set(code.length, Math.max(numeric, lastNumeric.get(code.length) ?? -1));
        out.push({ code, level, title, start, bodyStart });
    }
    return out;
}

// The annex proper starts at kategori A. What precedes it is the document
// header ("NOMOR 6 TAHUN 2026 TENTANG PERUBAHAN ..."), a run of capitals in
// which "2026" would otherwise pass for a subgolongan whose title swallows
// kategori A. What follows the last entry is the signature block.
const ANNEX_START_RE = /(?:^|\s)A\s+PERTANIAN\b[^a-z]*?\s+Kategori\b/;
const ANNEX_END_RE = /\s*KEPALA BADAN PUSAT STATISTIK[\s\S]*$/;

export function parseKbliAnnex(rawText: string, source: KbliSource): KbliDataset {
    const warnings: string[] = [];
    let text = rawText.replace(/\r/g, "");
    const startIdx = text.search(ANNEX_START_RE);
    if (startIdx > 0) text = text.slice(startIdx);
    else if (startIdx < 0) warnings.push("kategori A not found at the start of the annex; parsing from the top");
    text = text.replace(ANNEX_END_RE, "");

    // Every candidate is a plausible entry block, so each description runs to
    // the next candidate, whether or not that one is then kept: a repeated
    // code is skipped (first occurrence wins) but still bounds its neighbour.
    const candidates = findCandidates(text);
    const seen = new Set<string>();
    const entries: KbliEntry[] = [];
    let currentKategori: string | null = null;
    for (let i = 0; i < candidates.length; i += 1) {
        const c = candidates[i];
        if (seen.has(c.code)) {
            warnings.push(`duplicate code ${c.code} ("${normalizeTitle(c.title)}") skipped`);
            continue;
        }
        seen.add(c.code);
        const bodyEnd = i + 1 < candidates.length ? candidates[i + 1].start : text.length;
        const description = normalizeWhitespace(text.slice(c.bodyStart, bodyEnd));
        if (c.level === "kategori") currentKategori = c.code;
        const parent =
            c.level === "kategori" ? null : c.level === "golongan_pokok" ? currentKategori : c.code.slice(0, -1);
        entries.push({ code: c.code, level: c.level, title: normalizeTitle(c.title), description, parent });
    }

    // Structural sanity: every non-kategori entry should have its parent present.
    for (const e of entries) {
        if (e.parent && !seen.has(e.parent)) warnings.push(`entry ${e.code} has unknown parent ${e.parent}`);
    }

    return { source, entries, warnings };
}
