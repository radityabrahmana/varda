/**
 * DOCX list-numbering resolver.
 *
 * Word stores clause numbers such as "5.2.1." as automatic numbering
 * (`w:numPr` on the paragraph, definitions in `word/numbering.xml`), not as
 * text. Text extractors that only read `w:t` therefore drop every clause
 * number, and a model reading that text has to guess them. This module
 * replays the numbering definitions in document order and returns the label
 * Word would render in front of each paragraph, so extracted text can carry
 * the same numbers the reader sees in the document.
 *
 * Supported: multi-level `lvlText` patterns (`%1.%2.`), decimal / letter /
 * roman formats, `w:start`, legal numbering (`w:isLgl`), restarts through
 * `w:lvlOverride/w:startOverride`, numbering inherited from a paragraph style
 * (`w:pStyle` → `w:basedOn` chain), and `w:numStyleLink` indirection.
 * Bullets render as "•". Anything else falls back to decimal.
 */

import type JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function child(n: unknown, name: string): XNode | null {
    for (const c of elChildren(n)) if (elName(c) === name) return c;
    return null;
}

function val(n: XNode | null): string | undefined {
    if (!n) return undefined;
    const v = elAttrs(n)["@_w:val"];
    return v == null ? undefined : String(v);
}

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

async function readXml(zip: JSZip, path: string): Promise<XNode[] | null> {
    const entry = zip.file(path) ?? zip.file(path.replace(/\//g, "\\"));
    if (!entry) return null;
    const raw = await entry.async("string");
    try {
        return createParser().parse(raw) as XNode[];
    } catch {
        return null;
    }
}

/** Depth-first search for the first element with the given name. */
function findFirst(nodes: XNode[], name: string): XNode | null {
    for (const n of nodes) {
        if (elName(n) === name) return n;
        const hit = findFirst(elChildren(n), name);
        if (hit) return hit;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

interface LevelDef {
    start: number;
    numFmt: string;
    lvlText: string;
    isLgl: boolean;
    /** Paragraph style bound to this level (`w:lvl/w:pStyle`). */
    pStyle?: string;
}

interface AbstractDef {
    levels: Map<number, LevelDef>;
    numStyleLink?: string;
}

interface NumDef {
    abstractNumId: string;
    overrides: Map<number, { start?: number; level?: LevelDef }>;
}

interface StyleDef {
    basedOn?: string;
    numId?: string;
    ilvl?: number;
}

function parseLevel(lvl: XNode): LevelDef {
    const start = parseInt(val(child(lvl, "w:start")) ?? "1", 10);
    return {
        start: Number.isFinite(start) ? start : 1,
        numFmt: val(child(lvl, "w:numFmt")) ?? "decimal",
        lvlText: val(child(lvl, "w:lvlText")) ?? "",
        isLgl: child(lvl, "w:isLgl") !== null,
        pStyle: val(child(lvl, "w:pStyle")),
    };
}

function parseNumbering(tree: XNode[] | null): { abstracts: Map<string, AbstractDef>; nums: Map<string, NumDef> } {
    const abstracts = new Map<string, AbstractDef>();
    const nums = new Map<string, NumDef>();
    const root = tree ? findFirst(tree, "w:numbering") : null;
    if (!root) return { abstracts, nums };
    for (const n of elChildren(root)) {
        const name = elName(n);
        if (name === "w:abstractNum") {
            const id = elAttrs(n)["@_w:abstractNumId"];
            if (id == null) continue;
            const levels = new Map<number, LevelDef>();
            for (const lvl of elChildren(n)) {
                if (elName(lvl) !== "w:lvl") continue;
                const ilvl = parseInt(elAttrs(lvl)["@_w:ilvl"] ?? "", 10);
                if (!Number.isFinite(ilvl)) continue;
                levels.set(ilvl, parseLevel(lvl));
            }
            abstracts.set(String(id), { levels, numStyleLink: val(child(n, "w:numStyleLink")) });
        } else if (name === "w:num") {
            const id = elAttrs(n)["@_w:numId"];
            const abstractNumId = val(child(n, "w:abstractNumId"));
            if (id == null || abstractNumId == null) continue;
            const overrides = new Map<number, { start?: number; level?: LevelDef }>();
            for (const o of elChildren(n)) {
                if (elName(o) !== "w:lvlOverride") continue;
                const ilvl = parseInt(elAttrs(o)["@_w:ilvl"] ?? "", 10);
                if (!Number.isFinite(ilvl)) continue;
                const startRaw = val(child(o, "w:startOverride"));
                const start = startRaw == null ? undefined : parseInt(startRaw, 10);
                const lvlEl = child(o, "w:lvl");
                overrides.set(ilvl, {
                    start: start != null && Number.isFinite(start) ? start : undefined,
                    level: lvlEl ? parseLevel(lvlEl) : undefined,
                });
            }
            nums.set(String(id), { abstractNumId, overrides });
        }
    }
    return { abstracts, nums };
}

function parseStyles(tree: XNode[] | null): Map<string, StyleDef> {
    const styles = new Map<string, StyleDef>();
    const root = tree ? findFirst(tree, "w:styles") : null;
    if (!root) return styles;
    for (const s of elChildren(root)) {
        if (elName(s) !== "w:style") continue;
        const id = elAttrs(s)["@_w:styleId"];
        if (id == null) continue;
        const numPr = child(child(s, "w:pPr"), "w:numPr");
        const ilvlRaw = val(child(numPr, "w:ilvl"));
        const ilvl = ilvlRaw == null ? undefined : parseInt(ilvlRaw, 10);
        styles.set(String(id), {
            basedOn: val(child(s, "w:basedOn")),
            numId: val(child(numPr, "w:numId")),
            ilvl: ilvl != null && Number.isFinite(ilvl) ? ilvl : undefined,
        });
    }
    return styles;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function toRoman(n: number): string {
    if (n <= 0) return String(n);
    const table: [number, string][] = [
        [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
        [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
    ];
    let out = "";
    let rest = n;
    for (const [value, sym] of table) {
        while (rest >= value) {
            out += sym;
            rest -= value;
        }
    }
    return out;
}

/** Word's letter sequence: a..z, then aa, bb, cc … */
function toLetters(n: number): string {
    if (n <= 0) return String(n);
    const letter = String.fromCharCode(96 + ((n - 1) % 26) + 1);
    return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

function formatCounter(n: number, numFmt: string): string {
    switch (numFmt) {
        case "lowerLetter":
            return toLetters(n);
        case "upperLetter":
            return toLetters(n).toUpperCase();
        case "lowerRoman":
            return toRoman(n).toLowerCase();
        case "upperRoman":
            return toRoman(n);
        case "decimalZero":
            return n < 10 ? `0${n}` : String(n);
        case "none":
            return "";
        default:
            return String(n);
    }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface NumberingResolver {
    /**
     * The label Word renders before this paragraph ("5.2.1.", "(a)", "•"),
     * or "" when the paragraph is not numbered. Must be called once per
     * paragraph in document order, since it advances the list counters.
     */
    labelFor(paragraph: XNode): string;
}

const NO_NUMBERING: NumberingResolver = { labelFor: () => "" };

export async function createNumberingResolver(zip: JSZip): Promise<NumberingResolver> {
    const [numberingTree, stylesTree] = await Promise.all([
        readXml(zip, "word/numbering.xml"),
        readXml(zip, "word/styles.xml"),
    ]);
    const { abstracts, nums } = parseNumbering(numberingTree);
    if (nums.size === 0) return NO_NUMBERING;
    const styles = parseStyles(stylesTree);

    // Counters are shared by every w:num that points at the same abstractNum;
    // a w:num only starts its own sequence through a startOverride.
    const counters = new Map<string, (number | undefined)[]>();
    const startedNums = new Set<string>();

    const styleNumbering = (styleId: string | undefined): { numId: string; ilvl?: number } | null => {
        const seen = new Set<string>();
        let cur = styleId;
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            const s = styles.get(cur);
            if (!s) return null;
            if (s.numId != null) return { numId: s.numId, ilvl: s.ilvl };
            cur = s.basedOn;
        }
        return null;
    };

    /** Follow w:numStyleLink so the abstractNum with the real levels is used. */
    const resolveAbstract = (numId: string): { abstractNumId: string; abs: AbstractDef; num: NumDef } | null => {
        const num = nums.get(numId);
        if (!num) return null;
        let abstractNumId = num.abstractNumId;
        let abs = abstracts.get(abstractNumId);
        if (abs?.numStyleLink) {
            const linked = styleNumbering(abs.numStyleLink);
            const linkedNum = linked ? nums.get(linked.numId) : undefined;
            if (linkedNum) {
                abstractNumId = linkedNum.abstractNumId;
                abs = abstracts.get(abstractNumId);
            }
        }
        if (!abs) return null;
        return { abstractNumId, abs, num };
    };

    const levelDef = (abs: AbstractDef, num: NumDef, ilvl: number): LevelDef | undefined =>
        num.overrides.get(ilvl)?.level ?? abs.levels.get(ilvl);

    return {
        labelFor(paragraph: XNode): string {
            const pPr = child(paragraph, "w:pPr");
            const numPr = child(pPr, "w:numPr");
            let numId = val(child(numPr, "w:numId"));
            let ilvlRaw = val(child(numPr, "w:ilvl"));
            const styleId = val(child(pPr, "w:pStyle"));
            let ilvl = ilvlRaw == null ? undefined : parseInt(ilvlRaw, 10);

            if (numId == null) {
                const fromStyle = styleNumbering(styleId);
                if (!fromStyle) return "";
                numId = fromStyle.numId;
                ilvl = fromStyle.ilvl;
                ilvlRaw = undefined;
            }
            if (numId === "0") return "";
            const resolved = resolveAbstract(numId);
            if (!resolved) return "";
            const { abstractNumId, abs, num } = resolved;

            if (ilvl == null || !Number.isFinite(ilvl)) {
                // A style bound to a level through w:lvl/w:pStyle (Heading 1 → level 0).
                ilvl = 0;
                if (styleId) {
                    for (const [lvl, def] of abs.levels) {
                        if (def.pStyle === styleId) {
                            ilvl = lvl;
                            break;
                        }
                    }
                }
            }
            const def = levelDef(abs, num, ilvl);
            if (!def) return "";

            let ctr = counters.get(abstractNumId);
            if (!ctr) {
                ctr = [];
                counters.set(abstractNumId, ctr);
            }
            if (!startedNums.has(numId)) {
                startedNums.add(numId);
                for (const [lvl, o] of num.overrides) {
                    if (o.start == null) continue;
                    ctr[lvl] = o.start - 1;
                    for (let deeper = lvl + 1; deeper < ctr.length; deeper++) ctr[deeper] = undefined;
                }
            }

            for (let lvl = 0; lvl < ilvl; lvl++) {
                if (ctr[lvl] == null) ctr[lvl] = levelDef(abs, num, lvl)?.start ?? 1;
            }
            ctr[ilvl] = (ctr[ilvl] ?? def.start - 1) + 1;
            for (let deeper = ilvl + 1; deeper < ctr.length; deeper++) ctr[deeper] = undefined;

            if (def.numFmt === "bullet") return "•";
            const label = def.lvlText.replace(/%(\d)/g, (_m, d: string) => {
                const lvl = parseInt(d, 10) - 1;
                const n = ctr![lvl] ?? levelDef(abs, num, lvl)?.start ?? 1;
                const fmt = def.isLgl ? "decimal" : (levelDef(abs, num, lvl)?.numFmt ?? "decimal");
                return formatCounter(n, fmt);
            });
            return label.trim();
        },
    };
}
