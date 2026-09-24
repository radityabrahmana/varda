import { describe, expect, it } from "vitest";
import { chunkText, cleanExtractedText, parseRegulationText } from "./regulationParse";

// A miniature ministry regulation as a PDF extractor emits it: page markers,
// page numbers, a footer URL, preamble, chapters with titles on their own
// lines, articles with ayat, a wrapped cross-reference that puts "Pasal 3
// ayat (1)" at a line start, an elucidation and an annex.
const PERMEN = `[Page 1]
PERATURAN MENTERI PERHUBUNGAN REPUBLIK INDONESIA
NOMOR PM 60 TAHUN 2019
TENTANG
PENYELENGGARAAN ANGKUTAN BARANG DENGAN KENDARAAN BERMOTOR DI JALAN
Menimbang: a. bahwa angkutan barang perlu diatur;
Mengingat: 1. Undang-Undang Nomor 22 Tahun 2009;
MEMUTUSKAN:
BAB I
KETENTUAN UMUM
Pasal 1
Dalam Peraturan Menteri ini yang dimaksud dengan:
1. Angkutan adalah perpindahan orang dan/atau barang.
2. Kendaraan Bermotor adalah setiap kendaraan yang digerakkan oleh peralatan mekanik.
- 2 -
Pasal 2
(1) Angkutan barang dilakukan dengan mobil barang.
(2) Mobil barang sebagaimana dimaksud pada ayat (1) wajib memenuhi persyaratan teknis.
[Page 2]
BAB II
ANGKUTAN BARANG UMUM
Bagian Kesatu
Umum
Pasal 3
(1) Angkutan barang umum wajib memenuhi persyaratan sebagaimana dimaksud dalam
Pasal 2 ayat (2) dan dilengkapi dokumen.
(2) Dokumen sebagaimana dimaksud pada ayat (1) meliputi surat muatan.
Pasal 3A
Ketentuan tambahan.
www.jdih.dephub.go.id
Pasal 4
Pengemudi wajib memiliki SIM yang sesuai dengan golongan sebagaimana dimaksud dalam
Pasal 2
huruf a, dan membawa dokumen.
PENJELASAN
ATAS PERATURAN MENTERI PERHUBUNGAN NOMOR PM 60 TAHUN 2019
I. UMUM
Peraturan ini disusun untuk menata angkutan barang.
II. PASAL DEMI PASAL
Pasal 1
Cukup jelas.
Pasal 3
Yang dimaksud dengan dokumen adalah surat muatan dan surat jalan.
LAMPIRAN
PERATURAN MENTERI PERHUBUNGAN NOMOR PM 60 TAHUN 2019
Tabel persyaratan teknis mobil barang.
`;

describe("cleanExtractedText", () => {
    it("drops page markers, lone page numbers and URL-only lines", () => {
        const cleaned = cleanExtractedText("[Page 1]\nIsi\n- 2 -\n12\nwww.jdih.dephub.go.id\nLanjut\n\n\n\nAkhir");
        expect(cleaned).toBe("Isi\nLanjut\n\nAkhir");
    });
});

describe("parseRegulationText", () => {
    const parsed = parseRegulationText(PERMEN);
    const byKey = new Map(parsed.nodes.map((n) => [`${n.node_type}:${n.number ?? ""}`, n]));

    it("finds the articles in sequence and keeps a wrapped cross-reference inside its article", () => {
        const pasal = parsed.nodes.filter((n) => n.node_type === "pasal").map((n) => n.number);
        expect(pasal).toEqual(["1", "2", "3", "3A", "4"]);
        expect(parsed.stats.pasal).toBe(5);
        // "Pasal 2 ayat (2) ..." is not a heading shape at all; a bare
        // "Pasal 2" line inside article 4 is, but breaks the sequence.
        const p3 = byKey.get("pasal:3")!;
        expect(p3.content).toContain("sebagaimana dimaksud dalam\nPasal 2 ayat (2)");
        expect(p3.content).toContain("(2) Dokumen");
        const p4 = byKey.get("pasal:4")!;
        expect(p4.content).toContain("dimaksud dalam\nPasal 2\nhuruf a");
        expect(parsed.warnings).toEqual([expect.stringContaining('"Pasal 2" out of sequence')]);
    });

    it("captures structural headings with their titles and builds the context chain", () => {
        expect(byKey.get("bab:I")).toMatchObject({ heading: "KETENTUAN UMUM", context: null });
        expect(byKey.get("bab:II")).toMatchObject({ heading: "ANGKUTAN BARANG UMUM" });
        expect(byKey.get("bagian:Kesatu")).toMatchObject({ heading: "Umum", context: "BAB II ANGKUTAN BARANG UMUM" });
        expect(byKey.get("pasal:3")?.context).toBe("BAB II ANGKUTAN BARANG UMUM › Bagian Kesatu Umum");
        expect(byKey.get("pasal:1")?.context).toBe("BAB I KETENTUAN UMUM");
        expect(parsed.stats.structural).toBe(3);
    });

    it("keeps the preamble as its own node", () => {
        const preamble = byKey.get("preamble:")!;
        expect(preamble.heading).toBe("Pembukaan");
        expect(preamble.content).toContain("Menimbang: a. bahwa angkutan barang perlu diatur;");
        expect(preamble.content).toContain("MEMUTUSKAN:");
        expect(preamble.content).not.toContain("[Page 1]");
    });

    it("splits the elucidation into a general part and per-article entries", () => {
        expect(byKey.get("penjelasan:UMUM")?.content).toBe("Peraturan ini disusun untuk menata angkutan barang.");
        expect(byKey.get("penjelasan:1")?.content).toBe("Cukup jelas.");
        expect(byKey.get("penjelasan:3")?.content).toContain("surat muatan dan surat jalan");
        expect(parsed.stats.penjelasan).toBe(3);
        // The elucidation's own "Pasal 1" must not reopen article 1.
        expect(byKey.get("pasal:1")?.content).not.toContain("Cukup jelas");
    });

    it("stores the annex as content chunks", () => {
        const annex = parsed.nodes.filter((n) => n.node_type === "content");
        expect(annex).toHaveLength(1);
        expect(annex[0].heading).toBe("Lampiran");
        expect(annex[0].content).toContain("Tabel persyaratan teknis");
        expect(parsed.stats.content_chunks).toBe(1);
    });

    it("handles the civil code layout: BUKU, BAB with uppercase title, bare Pasal lines", () => {
        const text = `KITAB UNDANG-UNDANG HUKUM PERDATA
BUKU KETIGA
PERIKATAN
BAB I
PERIKATAN PADA UMUMNYA
Pasal 1233
Perikatan, lahir karena suatu persetujuan atau karena undang-undang.
Pasal 1234
Perikatan ditujukan untuk memberikan sesuatu, untuk berbuat sesuatu, atau untuk tidak berbuat sesuatu.
BAB IV
HAPUSNYA PERIKATAN
Pasal 1266
Syarat yang membatalkan dianggap selalu dicantumkan dalam persetujuan yang timbal balik.
Pasal 1267
Pihak yang terhadapnya perikatan tidak dipenuhi, dapat memilih.`;
        const r = parseRegulationText(text);
        const p1266 = r.nodes.find((n) => n.node_type === "pasal" && n.number === "1266")!;
        expect(p1266.context).toBe("BUKU KETIGA PERIKATAN › BAB IV HAPUSNYA PERIKATAN");
        expect(p1266.content).toBe("Syarat yang membatalkan dianggap selalu dicantumkan dalam persetujuan yang timbal balik.");
        expect(r.stats.pasal).toBe(4);
        expect(r.warnings).toEqual([]);
    });

    it("falls back to text chunks when there is no article structure", () => {
        const text = `Surat Edaran tentang jam operasional.\n\n${"Paragraf panjang. ".repeat(120)}\n\nPenutup.`;
        const r = parseRegulationText(text);
        expect(r.stats.pasal).toBe(0);
        expect(r.nodes.every((n) => n.node_type === "content")).toBe(true);
        expect(r.nodes.length).toBeGreaterThan(1);
        expect(r.warnings).toContainEqual(expect.stringContaining("no Pasal structure"));
    });
});

describe("chunkText", () => {
    it("splits on paragraph boundaries and hard-splits oversized paragraphs", () => {
        const chunks = chunkText(`${"a".repeat(900)}\n\n${"b".repeat(900)}\n\n${"c".repeat(3200)}`, 1500);
        expect(chunks.length).toBe(5);
        expect(chunks[0]).toBe("a".repeat(900));
        expect(chunks[1]).toBe("b".repeat(900));
        expect(chunks[2].length).toBe(1500);
    });
});
