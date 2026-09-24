import { describe, expect, it } from "vitest";
import {
    buildKbliIndex,
    getKbliIndex,
    KBLI_MAX_LIMIT,
    lookupKbli,
    lookupKbliCode,
    normalizeKbliCode,
    searchKbli,
    tokenize,
} from "./kbli";
import type { KbliDataset, KbliEntry } from "./kbliParse";

function entry(code: string, title: string, description: string, parent: string | null): KbliEntry {
    const level =
        code.length === 1 ? "kategori" : code.length === 2 ? "golongan_pokok" : code.length === 3 ? "golongan" : code.length === 4 ? "subgolongan" : "kelompok";
    return { code, level, title, description, parent };
}

const DATASET: KbliDataset = {
    source: { regulation: "Lampiran test", edition: "KBLI test", pasal_law_id: 1, url: "https://example.test", fetched_at: "2026-09-24" },
    warnings: [],
    entries: [
        entry("H", "TRANSPORTASI DAN PENYIMPANAN", "Kategori ini mencakup transportasi.", null),
        entry("49", "TRANSPORTASI DARAT", "Golongan pokok ini mencakup transportasi darat.", "H"),
        entry("492", "TRANSPORTASI DARAT LAINNYA", "Golongan ini mencakup transportasi darat lainnya.", "49"),
        entry("4923", "TRANSPORTASI JALAN UNTUK BARANG", "Subgolongan ini mencakup angkutan barang melalui jalan.", "492"),
        entry("49231", "ANGKUTAN BERMOTOR UNTUK BARANG UMUM", "Kelompok ini mencakup operasional transportasi barang dengan kendaraan bermotor. Kelompok ini tidak mencakup angkutan barang berbahaya, lihat kelompok 49232.", "4923"),
        entry("49232", "ANGKUTAN BERMOTOR UNTUK BARANG KHUSUS", "Kelompok ini mencakup angkutan barang berbahaya dan barang khusus dengan kendaraan bermotor.", "4923"),
        entry("53", "POS DAN KURIR", "Golongan pokok ini mencakup pos dan kurir.", "H"),
        entry("532", "AKTIVITAS KURIR", "Golongan ini mencakup kurir.", "53"),
        entry("5320", "AKTIVITAS KURIR", "Subgolongan ini mencakup kurir.", "532"),
        entry("53200", "AKTIVITAS KURIR", "Kelompok ini mencakup pengambilan, pengangkutan dan pengantaran surat dan paket oleh perusahaan selain pos nasional.", "5320"),
        entry("52109", "PERGUDANGAN DAN PENYIMPANAN LAINNYA", "Kelompok ini mencakup pergudangan untuk barang dagangan.", "5210"),
    ],
};
const INDEX = buildKbliIndex(DATASET);

describe("tokenize / normalizeKbliCode", () => {
    it("lowercases, strips punctuation and keeps short codes", () => {
        expect(tokenize("ANGKUTAN BERMOTOR (UMUM), 49231")).toEqual(["angkutan", "bermotor", "umum", "49231"]);
        expect(normalizeKbliCode(" 49.231 ")).toBe("49231");
        expect(normalizeKbliCode("h")).toBe("H");
    });
});

describe("lookupKbliCode", () => {
    it("returns the entry with its parent chain, children and siblings", () => {
        const r = lookupKbliCode(INDEX, "49231");
        expect(r.found).toBe(true);
        expect(r.entry).toMatchObject({ code: "49231", level: "kelompok", title: "ANGKUTAN BERMOTOR UNTUK BARANG UMUM", parent: "4923" });
        expect(r.ancestors.map((a) => a.code)).toEqual(["H", "49", "492", "4923"]);
        expect(r.children).toEqual([]);
        expect(r.siblings.map((s) => s.code)).toEqual(["49232"]);
    });

    it("lists children for a grouping level and no siblings", () => {
        const r = lookupKbliCode(INDEX, "4923");
        expect(r.children.map((c) => c.code)).toEqual(["49231", "49232"]);
        expect(r.siblings).toEqual([]);
    });

    it("walks up the prefixes for an unknown (KBLI 2020) code", () => {
        const r = lookupKbliCode(INDEX, "49431");
        expect(r.found).toBe(false);
        expect(r.nearest?.code).toBe("49");
        expect(r.ancestors.map((a) => a.code)).toEqual(["H", "49"]);
        expect(r.children.map((c) => c.code)).toEqual(["492"]);
    });

    it("reports nothing nearby when no prefix exists", () => {
        const r = lookupKbliCode(INDEX, "99999");
        expect(r).toMatchObject({ found: false, ancestors: [], children: [], siblings: [] });
        expect(r.nearest).toBeUndefined();
    });
});

describe("searchKbli", () => {
    it("ranks title matches above description matches and kelompok above groupings", () => {
        const codes = searchKbli(INDEX, "angkutan barang bermotor").map((m) => m.code);
        expect(codes[0]).toBe("49231");
        expect(codes).toContain("49232");
        expect(codes.indexOf("49231")).toBeLessThan(codes.indexOf("4923"));
    });

    it("matches word prefixes and ignores stopwords", () => {
        const codes = searchKbli(INDEX, "jasa kurir untuk paket").map((m) => m.code);
        expect(codes[0]).toBe("53200");
        expect(searchKbli(INDEX, "dan untuk yang")).toEqual([]);
    });

    it("finds descriptions, clips them and carries the parent chain", () => {
        const [m] = searchKbli(INDEX, "barang berbahaya");
        expect(m.code).toBe("49232");
        expect(m.ancestors.map((a) => a.code)).toEqual(["H", "49", "492", "4923"]);
        expect(m.description.length).toBeLessThanOrEqual(701);
    });

    it("honours the limit", () => {
        expect(searchKbli(INDEX, "transportasi", 2)).toHaveLength(2);
    });
});

describe("lookupKbli", () => {
    it("requires a code or a query", () => {
        expect(lookupKbli({}, INDEX)).toEqual({ error: "Provide a KBLI code, a query, or both." });
    });

    it("reports a missing dataset", () => {
        expect(lookupKbli({ code: "49231" }, null)).toEqual({ error: "KBLI dataset is not available on this server." });
    });

    it("combines code and query lookups with source and guidance", () => {
        const r = lookupKbli({ code: "49431", query: "angkutan barang", limit: 999 }, INDEX);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        expect(r.source).toEqual({ regulation: "Lampiran test", edition: "KBLI test", url: "https://example.test" });
        expect(r.code?.found).toBe(false);
        expect(r.query?.matches.length).toBeLessThanOrEqual(KBLI_MAX_LIMIT);
        expect(r.query?.matches[0].code).toBe("49231");
        expect(r.guidance.join(" ")).toContain("not in KBLI 2025");
        expect(r.guidance.join(" ")).toContain("PP 28/2025");
    });

    it("tells the model a grouping level is not what a business registers", () => {
        const r = lookupKbli({ code: "H" }, INDEX);
        if ("error" in r) throw new Error(r.error);
        expect(r.guidance[0]).toContain("grouping level");
    });
});

describe("bundled dataset", () => {
    it("loads and resolves the goods road transport code", () => {
        const index = getKbliIndex();
        expect(index).not.toBeNull();
        if (!index) return;
        expect(index.byCode.size).toBeGreaterThan(2000);
        const r = lookupKbliCode(index, "49231");
        expect(r.entry?.title).toBe("ANGKUTAN BERMOTOR UNTUK BARANG UMUM");
        expect(r.ancestors.map((a) => a.code)).toEqual(["H", "49", "492", "4923"]);
        expect(index.source.url).toContain("pasal.id");
    });
});
