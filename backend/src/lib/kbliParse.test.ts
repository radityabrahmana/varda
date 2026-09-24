import { describe, expect, it } from "vitest";
import { levelForCode, parseKbliAnnex, type KbliSource } from "./kbliParse";

const SOURCE: KbliSource = {
    regulation: "test",
    edition: "test",
    pasal_law_id: 1,
    url: "https://example.test",
    fetched_at: "2026-09-24",
};

// A miniature annex exercising every shape the real text has: a document
// header with a year that looks like a code, entries at line starts and
// mid-line after a cross-reference, titles with parentheses and spaced
// hyphens, a bullet-opening description, "Lihat kelompok" stubs, a code number
// inside running text, a repeated code, a plain-sentence opener at a line
// start, and the signature block.
const ANNEX = `LAMPIRAN
NOMOR 6 TAHUN 2026 TENTANG PERUBAHAN ATAS PERATURAN BADAN PUSAT STATISTIK NOMOR 7 TAHUN 2025 TENTANG KLASIFIKASI BAKU LAPANGAN USAHA INDONESIA KLASIFIKASI BAKU LAPANGAN USAHA INDONESIA A PERTANIAN, KEHUTANAN, DAN PERIKANAN Kategori ini mencakup eksploitasi sumber daya alam.
01 PERTANIAN TANAMAN, PETERNAKAN, PERBURUAN, DAN KEGIATAN JASA TERKAIT Golongan pokok ini mencakup produksi tanaman dan hewan.
011 PERTANIAN TANAMAN SEMUSIM Golongan ini mencakup penanaman tanaman semusim.
0111 PERTANIAN SEREALIA (BUKAN PADI), ANEKA KACANG, DAN BIJI - BIJIAN PENGHASIL MINYAK Subgolongan ini mencakup serealia, lihat kelompok 01112.
01111 PERTANIAN JAGUNG Kelompok ini mencakup kegiatan pertanian jagung dengan varietas SL 11 SHS, Bisi 2 dan lainnya. Kelompok ini tidak mencakup jagung manis, lihat kelompok 01133.
01112 PERTANIAN SEREALIA SELAIN PADI DAN JAGUNG Kelompok ini mencakup gandum. 0115 PERTANIAN TEMBAKAU Lihat kelompok 01150.
0125 PERTANIAN SAYURAN TAHUNAN, BUAH SEMAK, DAN BUAH BIJI KACANG - KACANGAN - pertanian buah beri;
- pertanian kacang - kacangan.
01150 PERTANIAN TEMBAKAU Kelompok ini mencakup pertanian tembakau.
01150 PERTANIAN TEMBAKAU Kelompok ini adalah pengulangan yang harus diabaikan.
B PERTAMBANGAN DAN PENGGALIAN Kategori pertambangan dan penggalian mencakup pengambilan mineral.
05 PERTAMBANGAN BATU BARA DAN LIGNIT Golongan pokok ini mencakup penambangan batu bara.
051 PERTAMBANGAN BATU BARA Lihat subgolongan 0510.
0510 PERTAMBANGAN BATU BARA
Subgolongan ini mencakup penambangan batu bara.
05100 PERTAMBANGAN BATU BARA
Kelompok ini mencakup penambangan batu bara, lihat juga ISCED-P 2011 untuk pendidikan.
9112 AKTIVITAS KEARSIPAN
Aktivitas kearsipan meliputi aktivitas yang dilakukan oleh semua pihak.
KEPALA BADAN PUSAT STATISTIK, ttd.
AMALIA ADININGGAR WIDYASANTI
`;

describe("levelForCode", () => {
    it("maps code shapes onto KBLI levels", () => {
        expect(levelForCode("A")).toBe("kategori");
        expect(levelForCode("01")).toBe("golongan_pokok");
        expect(levelForCode("011")).toBe("golongan");
        expect(levelForCode("0111")).toBe("subgolongan");
        expect(levelForCode("01111")).toBe("kelompok");
        expect(levelForCode("V")).toBeNull();
        expect(levelForCode("011111")).toBeNull();
    });
});

describe("parseKbliAnnex", () => {
    const dataset = parseKbliAnnex(ANNEX, SOURCE);
    const byCode = new Map(dataset.entries.map((e) => [e.code, e]));

    it("finds every real entry and nothing from the header or running text", () => {
        expect([...byCode.keys()].sort()).toEqual(
            ["0111", "01111", "01112", "0115", "01150", "0125", "05", "051", "0510", "05100", "01", "011", "9112", "A", "B"].sort(),
        );
        expect(byCode.has("2026")).toBe(false); // header year
        expect(byCode.has("11")).toBe(false); // "SL 11 SHS" inside a description
        expect(byCode.has("2011")).toBe(false); // "ISCED-P 2011"
    });

    it("starts at kategori A even when the header precedes it", () => {
        expect(byCode.get("A")).toMatchObject({ level: "kategori", title: "PERTANIAN, KEHUTANAN, DAN PERIKANAN", parent: null });
        expect(byCode.get("A")?.description).toMatch(/^Kategori ini mencakup/);
    });

    it("keeps parentheses in titles and collapses spaced hyphens", () => {
        expect(byCode.get("0111")?.title).toBe("PERTANIAN SEREALIA (BUKAN PADI), ANEKA KACANG, DAN BIJI-BIJIAN PENGHASIL MINYAK");
        expect(byCode.get("0125")?.title).toBe("PERTANIAN SAYURAN TAHUNAN, BUAH SEMAK, DAN BUAH BIJI KACANG-KACANGAN");
        expect(byCode.get("0125")?.description).toMatch(/^- pertanian buah beri; - pertanian kacang - kacangan\.$/);
    });

    it("splits an entry that starts mid-line after the previous description", () => {
        expect(byCode.get("01112")?.description).toBe("Kelompok ini mencakup gandum.");
        expect(byCode.get("0115")).toMatchObject({ level: "subgolongan", description: "Lihat kelompok 01150." });
    });

    it("accepts a kategori whose description does not open with 'Kategori ini'", () => {
        expect(byCode.get("B")?.description).toMatch(/^Kategori pertambangan dan penggalian mencakup/);
        expect(byCode.get("05")?.parent).toBe("B");
    });

    it("accepts a plain-sentence opener only at a line start", () => {
        expect(byCode.get("9112")?.description).toMatch(/^Aktivitas kearsipan meliputi/);
    });

    it("derives parents from the code hierarchy and the current kategori", () => {
        expect(byCode.get("01")?.parent).toBe("A");
        expect(byCode.get("011")?.parent).toBe("01");
        expect(byCode.get("0111")?.parent).toBe("011");
        expect(byCode.get("01111")?.parent).toBe("0111");
    });

    it("keeps the first occurrence of a repeated code and reports the duplicate", () => {
        expect(byCode.get("01150")?.description).toBe("Kelompok ini mencakup pertanian tembakau.");
        expect(dataset.warnings).toContainEqual(expect.stringContaining("duplicate code 01150"));
    });

    it("drops the signature block and reports unknown parents", () => {
        expect(byCode.get("9112")?.description).not.toContain("KEPALA BADAN");
        expect(dataset.warnings).toContainEqual("entry 9112 has unknown parent 911");
    });
});
