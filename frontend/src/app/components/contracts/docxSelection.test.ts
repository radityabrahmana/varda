import { describe, expect, it } from "vitest";
import { captureDocxSelection, replacementFor } from "./docxSelection";

function mount(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}

function rangeOver(node: Node, start: number, end: number, endNode: Node = node): Range {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(endNode, end);
    return r;
}

describe("captureDocxSelection", () => {
    it("returns the selection with paragraph context, leaving pending deletions out of the text", () => {
        const root = mount(
            '<p id="p"><span>Pembayaran dilakukan </span><del>segera </del><span>dalam 30 hari setelah invoice.</span></p>',
        );
        const text = root.querySelector("#p")!.lastChild!.firstChild!; // "dalam 30 hari setelah invoice."
        const r = captureDocxSelection(root, rangeOver(text, 6, 13)); // "30 hari"
        expect(r).toEqual({
            ok: true,
            selected: "30 hari",
            contextBefore: "Pembayaran dilakukan dalam ",
            contextAfter: " setelah invoice.",
        });
    });

    it("moves edge whitespace of the selection into the context", () => {
        const root = mount("<p>Denda keterlambatan 2% per bulan.</p>");
        const text = root.querySelector("p")!.firstChild!;
        const r = captureDocxSelection(root, rangeOver(text, 19, 23)); // " 2% "
        expect(r).toMatchObject({ ok: true, selected: "2%", contextBefore: "Denda keterlambatan ", contextAfter: " per bulan." });
    });

    it("refuses selections across paragraphs, outside a paragraph, or touching a pending change", () => {
        const root = mount('<p id="a">Pasal 1 berlaku.</p><p id="b">Pasal 2 <ins>baru</ins> berlaku.</p><div id="x">bebas</div>');
        const a = root.querySelector("#a")!.firstChild!;
        const b = root.querySelector("#b")!.firstChild!;
        expect(captureDocxSelection(root, rangeOver(a, 0, 3, b))).toMatchObject({ ok: false, reason: expect.stringMatching(/satu paragraf/) });
        expect(captureDocxSelection(root, rangeOver(root.querySelector("#x")!.firstChild!, 0, 3))).toMatchObject({ ok: false });
        const ins = root.querySelector("ins")!.firstChild!;
        expect(captureDocxSelection(root, rangeOver(ins, 0, 4))).toMatchObject({ ok: false, reason: expect.stringMatching(/belum diputuskan/) });
    });

    it("refuses a whitespace-only selection", () => {
        const root = mount("<p>A  B</p>");
        expect(captureDocxSelection(root, rangeOver(root.querySelector("p")!.firstChild!, 1, 3))).toMatchObject({ ok: false });
    });
});

describe("replacementFor", () => {
    it("maps each mode to the replacement the backend diffs against the selection", () => {
        expect(replacementFor("replace", "30 hari", "14 hari")).toBe("14 hari");
        expect(replacementFor("delete", "30 hari", "ignored")).toBe("");
        expect(replacementFor("insert_after", "30 hari", " kalender ")).toBe("30 hari kalender");
        expect(replacementFor("insert_after", "30 hari", ", paling lambat")).toBe("30 hari, paling lambat");
        expect(replacementFor("insert_after", "30 hari ", "kalender")).toBe("30 hari kalender");
        expect(replacementFor("insert_after", "30 hari", "  ")).toBe("30 hari");
    });
});
