import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
    applyTrackedEdits,
    extractDocxBodyText,
    extractTrackedChangeIds,
    resolveTrackedChange,
} from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Build a minimal in-memory .docx: a zip whose word/document.xml wraps the
 * given body XML. No [Content_Types].xml etc. — the module only reads
 * word/document.xml, so this is the smallest fixture that exercises it.
 */
async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function readDocumentXml(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("word/document.xml")!.async("string");
}

describe("extractDocxBodyText", () => {
    it("joins paragraph texts with newlines", async () => {
        const bytes = await makeDocx(para("First paragraph.") + para("Second."));
        await expect(extractDocxBodyText(bytes)).resolves.toBe(
            "First paragraph.\nSecond.",
        );
    });

    it("preserves numeric-looking text through an unrelated edit", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t>12.10</w:t></w:r>` +
                `<w:r><w:t> applies.</w:t></w:r>` +
                `</w:p>`,
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "applies",
                replace: "governs",
                context_before: " ",
                context_after: ".",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(await readDocumentXml(result.bytes)).toContain("<w:t>12.10</w:t>");
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "12.10 governs.",
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("12.10 applies.");
    });

    it("uses the accepted view: w:ins text included, w:del text excluded", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">Keep </w:t></w:r>` +
                `<w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins>` +
                `<w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
                `</w:p>`,
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("Keep added");
    });

    it("returns an empty string when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractDocxBodyText(bytes)).resolves.toBe("");
    });
});

describe("applyTrackedEdits", () => {
    it("emits a w:del/w:ins pair for a replacement and reports the change", async () => {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "ten dollars",
                replace: "five dollars",
                context_before: "The fee is ",
                context_after: ".",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change.deletedText).toBe("ten");
        expect(change.insertedText).toBe("five");
        expect(change.delId).toBeDefined();
        expect(change.insId).toBeDefined();

        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain("<w:del");
        expect(xml).toContain("<w:ins");
        expect(xml).toContain(`w:author="Varda"`);
        expect(xml).toContain("<w:delText");

        // Accepted view of the output shows the replacement applied.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "The fee is five dollars.",
        );
    });

    it("trims common prefix/suffix so only the changed span is tracked", async () => {
        const bytes = await makeDocx(para("Payment due in 30 days."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Payment due in 30 days",
                replace: "Payment due in 45 days",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].deletedText).toBe("30");
        expect(result.changes[0].insertedText).toBe("45");
    });

    it("honours a custom author", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(
            bytes,
            [{ find: "world", replace: "there", context_before: "", context_after: "" }],
            { author: "Reviewer" },
        );
        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain(`w:author="Reviewer"`);
    });

    it("supports a pure insertion anchored on context_before", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "",
                replace: "brave ",
                context_before: "Hello ",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeUndefined();
        expect(result.changes[0].insId).toBeDefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello brave world.",
        );
    });

    it("supports a pure deletion (empty replace)", async () => {
        const bytes = await makeDocx(para("Hello cruel world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "cruel ",
                replace: "",
                context_before: "Hello ",
                context_after: "world",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeDefined();
        expect(result.changes[0].insId).toBeUndefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("numbers new tracked changes above the existing max w:id", async () => {
        const bytes = await makeDocx(
            `<w:p><w:ins w:id="7"><w:r><w:t>Existing insertion. </w:t></w:r></w:ins>` +
                `<w:r><w:t xml:space="preserve">Plain text.</w:t></w:r></w:p>`,
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Plain",
                replace: "Simple",
                context_before: "",
                context_after: " text.",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBe("8");
        expect(result.changes[0].insId).toBe("9");
    });

    it("reports an error for a find that is not in the document", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "goodbye",
                replace: "farewell",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Could not locate") },
        ]);
        // The document itself is returned intact.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("reports an ambiguous match instead of guessing", async () => {
        const bytes = await makeDocx(para("alpha beta alpha"));
        const result = await applyTrackedEdits(bytes, [
            { find: "alpha", replace: "gamma", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Ambiguous match") },
        ]);
    });

    it("rejects empty edits and uncontexted pure insertions", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            { find: "", replace: "", context_before: "", context_after: "" },
            { find: "", replace: "orphan", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: "Empty edit." },
            {
                index: 1,
                reason: "Pure insertion requires context_before or context_after.",
            },
        ]);
    });

    it("throws when word/document.xml is missing from the archive", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(applyTrackedEdits(bytes, [])).rejects.toThrow(
            "document.xml missing from docx",
        );
    });

    it("rejects bytes that are not a zip archive at all", async () => {
        await expect(
            applyTrackedEdits(Buffer.from("plainly not a zip"), []),
        ).rejects.toThrow();
    });
});

describe("applyTrackedEdits — word granularity", () => {
    async function diff(text: string, find: string, replace: string, granularity?: "char" | "word") {
        const idx = text.indexOf(find);
        const result = await applyTrackedEdits(
            await makeDocx(para(text)),
            [{ find, replace, context_before: text.slice(0, idx), context_after: text.slice(idx + find.length) }],
            granularity ? { granularity } : undefined,
        );
        expect(result.errors).toEqual([]);
        const accepted = await extractDocxBodyText(result.bytes);
        expect(accepted).toBe(text.slice(0, idx) + replace + text.slice(idx + find.length));
        return { deleted: result.changes[0].deletedText, inserted: result.changes[0].insertedText, insId: result.changes[0].insId, delId: result.changes[0].delId };
    }

    it("keeps the minimal character diff by default (AI / Assistant edits)", async () => {
        expect(await diff("Made on 11 June 2026.", "11 June 2026", "12 June 2026")).toMatchObject({ deleted: "1", inserted: "2" });
    });

    it("widens a change to whole words", async () => {
        expect(await diff("Made on 11 June 2026.", "11 June 2026", "12 June 2026", "word")).toMatchObject({ deleted: "11", inserted: "12" });
        expect(await diff("dalam 30 hari kerja", "30 hari", "14 hari", "word")).toMatchObject({ deleted: "30", inserted: "14" });
        expect(await diff("jangka waktu harian", "harian", "bulanan", "word")).toMatchObject({ deleted: "harian", inserted: "bulanan" });
        expect(await diff("Pihak Pertama wajib membayar", "Pertama", "Kedua", "word")).toMatchObject({ deleted: "Pertama", inserted: "Kedua" });
    });

    it("keeps a pure insertion or deletion at a word boundary as a lone w:ins / w:del", async () => {
        const ins = await diff("dalam 30 hari setelah", "30 hari", "30 hari kalender", "word");
        expect(ins).toMatchObject({ deleted: "", inserted: " kalender", delId: undefined });
        const del = await diff("wajib dan segera membayar", "dan segera", "dan", "word");
        expect(del).toMatchObject({ deleted: " segera", inserted: "", insId: undefined });
    });

    it("widens an in-word extension to the whole word instead of splicing letters", async () => {
        // "hari" -> "harian": Word shows ~~hari~~ harian, not hari+an.
        expect(await diff("tiap hari kerja", "hari", "harian", "word")).toMatchObject({ deleted: "hari", inserted: "harian" });
    });

    it("changes a formatted amount as one token, and stops at ordinary punctuation", async () => {
        expect(await diff("Rp 50.000.000 per tahun", "50.000.000", "10.000.000", "word")).toMatchObject({ deleted: "50.000.000", inserted: "10.000.000" });
        expect(await diff("denda 1,5% per bulan", "1,5%", "2%", "word")).toMatchObject({ deleted: "1,5", inserted: "2" });
        expect(await diff("Pasal 5. Ganti rugi", "Pasal 5.", "Pasal 7.", "word")).toMatchObject({ deleted: "5", inserted: "7" });
        expect(await diff("la société générale", "société", "sociétés", "word")).toMatchObject({ deleted: "société", inserted: "sociétés" });
    });
});

describe("resolveTrackedChange", () => {
    /** Apply one replace edit and return the output bytes + w:ids. */
    async function trackedFixture() {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "ten",
                replace: "twenty",
                context_before: "The fee is ",
                context_after: " dollars",
            },
        ]);
        expect(applied.errors).toEqual([]);
        const { delId, insId } = applied.changes[0];
        return { bytes: applied.bytes, delId: delId!, insId: insId! };
    }

    it("accept collapses the change to the new text", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "accept");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is twenty dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
    });

    it("reject restores the original text, converting w:delText back to w:t", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "reject");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is ten dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
        const xml = await readDocumentXml(resolved.bytes);
        expect(xml).not.toContain("w:delText");
    });

    it("returns found=false and leaves the document alone for unknown ids", async () => {
        const { bytes } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, ["999"], "accept");
        expect(resolved.found).toBe(false);
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toHaveLength(2);
    });
});

describe("extractTrackedChangeIds", () => {
    it("lists w:ins/w:del wrappers in document order", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:ins w:id="3"><w:r><w:t>a</w:t></w:r></w:ins>` +
                `<w:del w:id="5"><w:r><w:delText>b</w:delText></w:r></w:del>` +
                `<w:ins w:id="9"><w:r><w:t>c</w:t></w:r></w:ins>` +
                `</w:p>`,
        );
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([
            { kind: "ins", w_id: "3" },
            { kind: "del", w_id: "5" },
            { kind: "ins", w_id: "9" },
        ]);
    });

    it("returns [] when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([]);
    });
});

describe("tabs and line breaks", () => {
    it("reads w:tab / w:br as characters and writes them back as elements through an edit", async () => {
        const bytes = await makeDocx(
            `<w:p><w:r><w:t>NAME / NAMA</w:t><w:tab/><w:t>: Robert Mulianto</w:t><w:br/><w:t>TITLE</w:t></w:r></w:p>`,
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("NAME / NAMA\t: Robert Mulianto\nTITLE");

        const result = await applyTrackedEdits(bytes, [
            { find: "NAME / NAMA\t: Robert Mulianto", replace: "NAME / NAMA\t: Budi Santosa", context_before: "", context_after: "" },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0]).toMatchObject({ deletedText: "Robert Mulianto", insertedText: "Budi Santosa" });
        const xml = await readDocumentXml(result.bytes);
        expect(xml).toMatch(/<w:tab(\/>|><\/w:tab>)/);
        expect(xml).toMatch(/<w:br(\/>|><\/w:br>)/);
        expect(xml).not.toMatch(/<w:t[^>]*>[^<]*\t/);
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe("NAME / NAMA\t: Budi Santosa\nTITLE");
    });

    it("keeps a page break out of the text stream", async () => {
        const bytes = await makeDocx(`<w:p><w:r><w:t>Before</w:t><w:br w:type="page"/><w:t>After</w:t></w:r></w:p>`);
        await expect(extractDocxBodyText(bytes)).resolves.toBe("BeforeAfter");
    });
});

describe("anchor fallbacks", () => {
    const CLAUSE =
        "Tanggung jawab Dash pada Konsumen untuk kehilangan dan/atau kerusakan Produk dalam hubungannya dengan Layanan Pengiriman akan sesuai dengan peraturan yang berlaku, dan dalam hal ketiadaan peraturan yang berlaku, maka tanggung jawab Dash akan terbatas Rp. 5,000,- per kilogram dengan total tanggung jawab per tahun sebesar Rp. 20,000,000,-;";

    it("strips a leading clause label the model copied from the numbered extraction", async () => {
        const bytes = await makeDocx(para("Intro.") + para(CLAUSE) + para("Outro."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: `5.2.1. ${CLAUSE}`,
                replace: "5.2.1. Tanggung jawab Dash kepada Pelanggan terbatas pada Rp 1.000.000,- per kejadian.",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        // collapseDiff keeps the shared "Tanggung jawab Dash " prefix; the label never enters the change.
        expect(result.changes[0].deletedText).toContain("pada Konsumen untuk kehilangan");
        expect(result.changes[0].deletedText).not.toContain("5.2.1.");
        expect(result.changes[0].insertedText).not.toContain("5.2.1.");
        await expect(extractDocxBodyText(result.bytes)).resolves.toContain(
            "Tanggung jawab Dash kepada Pelanggan terbatas pada Rp 1.000.000,- per kejadian.",
        );
    });

    it("does not strip a bare number that is part of the text when the verbatim needle matches", async () => {
        const bytes = await makeDocx(para("Pembayaran dalam waktu 5 (lima) hari kerja."));
        const result = await applyTrackedEdits(bytes, [
            { find: "5 (lima) hari kerja", replace: "7 (tujuh) hari kalender", context_before: "", context_after: "" },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0]).toMatchObject({ deletedText: "5 (lima) hari kerja", insertedText: "7 (tujuh) hari kalender" });
    });

    it("tolerates a closing full stop the paragraph does not have, on both sides of the edit", async () => {
        const bytes = await makeDocx(
            para("In the event of any inconsistency between the Indonesian and English versions, the English version shall prevail"),
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "In the event of any inconsistency between the Indonesian and English versions, the English version shall prevail.",
                replace: "In the event of any inconsistency between the Indonesian and English versions, the Indonesian version shall prevail.",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0]).toMatchObject({ deletedText: "English", insertedText: "Indonesian" });
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "In the event of any inconsistency between the Indonesian and English versions, the Indonesian version shall prevail",
        );
    });

    it("matches when the model dropped or added whitespace around a tab", async () => {
        const bytes = await makeDocx(`<w:p><w:r><w:t>Rp 5.000,-</w:t><w:tab/><w:t>per kilogram</w:t></w:r></w:p>`);
        const result = await applyTrackedEdits(bytes, [
            { find: "Rp 5.000,-per kilogram", replace: "Rp 1.000.000,-per kejadian", context_before: "", context_after: "" },
        ]);
        expect(result.errors).toEqual([]);
        // The replacement is the model's text, so the tab it left out is gone too.
        expect(result.changes[0].deletedText).toBe("5.000,-\tper kilogram");
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe("Rp 1.000.000,-per kejadian");
    });

    it("anchors a paraphrased quote on the paragraph span it mostly covers", async () => {
        const sibling =
            "Tanggung jawab Dash dalam kasus lainnya atau dalam kondisi lainnya akan dibatasi pada jumlah agregat maksimum sebesar Rp. 20,000,000,- per tahun;";
        const bytes = await makeDocx(para("5.2. Batasan.") + para(CLAUSE) + para(sibling));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Tanggung jawab Dash pada Konsumen untuk kehilangan dan/atau kerusakan Produk dalam hubungannya dengan Layanan Pengiriman akan sesuai dengan peraturan yang berlaku, dan dalam hal ketiadaan peraturan yang berlaku, maka tanggung jawab Dash akan terbatas Rp. 5,000,- per kilogram, subject to an aggregate maximum of Rp. 20,000,000,- per annum;",
                replace: "Tanggung jawab Dash kepada Pelanggan akan terbatas pada Rp 1.000.000,- per kejadian.",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].deletedText).toBe(
            "pada Konsumen untuk kehilangan dan/atau kerusakan Produk dalam hubungannya dengan Layanan Pengiriman akan sesuai dengan peraturan yang berlaku, dan dalam hal ketiadaan peraturan yang berlaku, maka tanggung jawab Dash akan terbatas Rp. 5,000,- per kilogram dengan total tanggung jawab per tahun sebesar Rp. 20,000,000,-;",
        );
        const text = await extractDocxBodyText(result.bytes);
        expect(text.split("\n")[1]).toBe("Tanggung jawab Dash kepada Pelanggan akan terbatas pada Rp 1.000.000,- per kejadian.");
        expect(text).toContain(sibling);
    });

    it("refuses a fuzzy match that two paragraphs fit equally well, and a short or unrelated quote", async () => {
        const a = "Dash tidak akan bertanggung jawab untuk kehilangan laba, kehilangan penjualan, kehilangan pasar, kehilangan nama baik atau reputasi;";
        const b = "Dash tidak akan bertanggung jawab untuk kehilangan laba, kehilangan penjualan, kehilangan pasar, kehilangan nama baik atau goodwill;";
        const twin = await makeDocx(para(a) + para(b));
        const ambiguous = await applyTrackedEdits(twin, [
            {
                find: "Dash tidak akan bertanggung jawab untuk kehilangan laba, kehilangan penjualan, kehilangan pasar, kehilangan nama baik atau citra;",
                replace: "x",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(ambiguous.errors).toEqual([{ index: 0, reason: expect.stringContaining("Ambiguous match") }]);

        const single = await makeDocx(para(a));
        const unrelated = await applyTrackedEdits(single, [
            { find: "Customer shall pay all invoices within seven calendar days of the invoice date without set-off.", replace: "x", context_before: "", context_after: "" },
            { find: "kehilangan laba tanpa batas", replace: "x", context_before: "", context_after: "" },
        ]);
        expect(unrelated.errors.map((e) => e.index)).toEqual([0, 1]);
        expect(unrelated.errors[0].reason).toContain("Could not locate");
    });
});
