import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createNumberingResolver } from "../docxNumbering";
import { extractDocxBodyText } from "../docxTrackedChanges";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function lvl(ilvl: number, lvlText: string, opts: { numFmt?: string; start?: number; isLgl?: boolean; pStyle?: string } = {}): string {
    return (
        `<w:lvl w:ilvl="${ilvl}">` +
        `<w:start w:val="${opts.start ?? 1}"/>` +
        `<w:numFmt w:val="${opts.numFmt ?? "decimal"}"/>` +
        (opts.isLgl ? "<w:isLgl/>" : "") +
        (opts.pStyle ? `<w:pStyle w:val="${opts.pStyle}"/>` : "") +
        `<w:lvlText w:val="${lvlText}"/>` +
        `</w:lvl>`
    );
}

const LEGAL_ABSTRACT =
    `<w:abstractNum w:abstractNumId="0">` +
    lvl(0, "%1.") +
    lvl(1, "%1.%2.") +
    lvl(2, "%1.%2.%3.") +
    `</w:abstractNum>`;

function numberingXml(abstracts: string, nums: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}>${abstracts}${nums}</w:numbering>`;
}

function numbered(text: string, numId: number, ilvl: number): string {
    return (
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
        `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
    );
}

function styled(text: string, styleId: string): string {
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function plain(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function makeDocx(bodyXml: string, parts: { numbering?: string; styles?: string } = {}): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    if (parts.numbering) zip.file("word/numbering.xml", parts.numbering);
    if (parts.styles) zip.file("word/styles.xml", parts.styles);
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("createNumberingResolver", () => {
    it("renders multi-level legal numbering in document order and resets deeper levels", async () => {
        const numbering = numberingXml(LEGAL_ABSTRACT, `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`);
        const bytes = await makeDocx(
            numbered("Definitions", 1, 0) +
                numbered("Liability", 1, 0) +
                numbered("Products", 1, 1) +
                numbered("Dash shall only be liable", 1, 2) +
                numbered("In no case", 1, 2) +
                numbered("Other liability", 1, 1) +
                plain("Signed by the Parties.") +
                numbered("Indemnity", 1, 0),
            { numbering },
        );
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe(
            [
                "1. Definitions",
                "2. Liability",
                "2.1. Products",
                "2.1.1. Dash shall only be liable",
                "2.1.2. In no case",
                "2.2. Other liability",
                "Signed by the Parties.",
                "3. Indemnity",
            ].join("\n"),
        );
        // The default extraction is unchanged.
        await expect(extractDocxBodyText(bytes)).resolves.toContain("Definitions\nLiability\nProducts");
    });

    it("numbers paragraphs inside table cells in reading order", async () => {
        const numbering = numberingXml(LEGAL_ABSTRACT, `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`);
        const bytes = await makeDocx(
            `<w:tbl><w:tr>` +
                `<w:tc>${numbered("Title, Risk and Insurance", 1, 0)}${numbered("Title and risk", 1, 1)}</w:tc>` +
                `<w:tc>${plain("Hak Kepemilikan, Resiko, dan Asuransi")}${plain("Hak kepemilikan")}</w:tc>` +
                `</w:tr></w:tbl>`,
            { numbering },
        );
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe(
            "1. Title, Risk and Insurance\n1.1. Title and risk\nHak Kepemilikan, Resiko, dan Asuransi\nHak kepemilikan",
        );
    });

    it("formats letters, roman numerals, zero-padded decimals and bullets", async () => {
        const abstracts =
            `<w:abstractNum w:abstractNumId="0">` +
            lvl(0, "(%1)", { numFmt: "lowerLetter" }) +
            lvl(1, "%2.", { numFmt: "upperRoman" }) +
            lvl(2, "%3", { numFmt: "decimalZero" }) +
            `</w:abstractNum>` +
            `<w:abstractNum w:abstractNumId="1">` +
            lvl(0, "", { numFmt: "bullet" }) +
            `</w:abstractNum>`;
        const numbering = numberingXml(
            abstracts,
            `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`,
        );
        const body =
            Array.from({ length: 27 }, (_, i) => numbered(`item ${i + 1}`, 1, 0)).join("") +
            numbered("four", 1, 1) +
            numbered("five", 1, 1) +
            numbered("padded", 1, 2) +
            numbered("dot", 2, 0);
        const text = await extractDocxBodyText(await makeDocx(body, { numbering }), { numbering: true });
        const lines = text.split("\n");
        expect(lines[0]).toBe("(a) item 1");
        expect(lines[25]).toBe("(z) item 26");
        expect(lines[26]).toBe("(aa) item 27");
        expect(lines[27]).toBe("I. four");
        expect(lines[28]).toBe("II. five");
        expect(lines[29]).toBe("01 padded");
        expect(lines[30]).toBe("• dot");
    });

    it("shares counters between nums of one abstractNum unless a startOverride restarts them", async () => {
        const numbering = numberingXml(
            LEGAL_ABSTRACT,
            `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
                `<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>` +
                `<w:num w:numId="3"><w:abstractNumId w:val="0"/>` +
                `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
        );
        const bytes = await makeDocx(
            numbered("one", 1, 0) + numbered("two", 2, 0) + numbered("restart", 3, 0) + numbered("restart sub", 3, 1),
            { numbering },
        );
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe(
            "1. one\n2. two\n1. restart\n1.1. restart sub",
        );
    });

    it("applies legal (isLgl) numbering and a lvlOverride level definition", async () => {
        const abstracts =
            `<w:abstractNum w:abstractNumId="0">` +
            lvl(0, "%1.", { numFmt: "upperRoman" }) +
            lvl(1, "%1.%2", { isLgl: true }) +
            `</w:abstractNum>`;
        const numbering = numberingXml(
            abstracts,
            `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
                `<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0">` +
                lvl(0, "Article %1", { start: 10 }) +
                `</w:lvlOverride></w:num>`,
        );
        const bytes = await makeDocx(numbered("a", 1, 0) + numbered("b", 1, 1) + numbered("c", 2, 0), { numbering });
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe("I. a\n1.1 b\nArticle 2 c");
    });

    it("inherits numbering from a paragraph style, its basedOn chain, and w:lvl/w:pStyle levels", async () => {
        const abstracts =
            `<w:abstractNum w:abstractNumId="0">` +
            lvl(0, "Bab %1", { pStyle: "Heading1" }) +
            lvl(1, "%1.%2", { pStyle: "Heading2" }) +
            `</w:abstractNum>`;
        const numbering = numberingXml(abstracts, `<w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>`);
        const styles =
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>` +
            `<w:style w:type="paragraph" w:styleId="Heading1"><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr></w:style>` +
            `<w:style w:type="paragraph" w:styleId="Heading2"><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr></w:style>` +
            `<w:style w:type="paragraph" w:styleId="Heading2Custom"><w:basedOn w:val="Heading2"/></w:style>` +
            `<w:style w:type="paragraph" w:styleId="Normal"/>` +
            `</w:styles>`;
        const bytes = await makeDocx(
            styled("Scope", "Heading1") + styled("Services", "Heading2") + styled("Fees", "Heading2Custom") + styled("Body", "Normal"),
            { numbering, styles },
        );
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe("Bab 1 Scope\n1.1 Services\n1.2 Fees\nBody");
    });

    it("follows w:numStyleLink to the abstractNum that carries the levels", async () => {
        const abstracts =
            `<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="LegalList"/></w:abstractNum>` +
            `<w:abstractNum w:abstractNumId="1">${lvl(0, "%1)")}</w:abstractNum>`;
        const numbering = numberingXml(
            abstracts,
            `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`,
        );
        const styles =
            `<w:styles ${W_NS}><w:style w:type="numbering" w:styleId="LegalList"><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style></w:styles>`;
        const bytes = await makeDocx(numbered("linked", 1, 0), { numbering, styles });
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe("1) linked");
    });

    it("leaves paragraphs unnumbered for numId 0, unknown nums, no numbering part, or a level without a definition", async () => {
        const numbering = numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, "%1.")}</w:abstractNum>`, `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`);
        const bytes = await makeDocx(
            numbered("off", 0, 0) + numbered("missing", 9, 0) + numbered("deep", 1, 4) + numbered("on", 1, 0),
            { numbering },
        );
        await expect(extractDocxBodyText(bytes, { numbering: true })).resolves.toBe("off\nmissing\ndeep\n1. on");

        const noPart = await makeDocx(numbered("alone", 1, 0));
        await expect(extractDocxBodyText(noPart, { numbering: true })).resolves.toBe("alone");

        const zip = await JSZip.loadAsync(await makeDocx(plain("x"), { numbering: "<not xml" }));
        const resolver = await createNumberingResolver(zip);
        expect(resolver.labelFor({ "w:p": [] })).toBe("");
    });
});
