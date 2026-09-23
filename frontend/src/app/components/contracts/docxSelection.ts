// Turn a browser selection inside the rendered DOCX (docx-preview output) into
// the anchor the backend's tracked-change engine needs: the selected text plus
// the paragraph text around it, in the "accepted view" the engine matches
// against — pending insertions count as text, pending deletions (<del>) do not.
//
// Refused selections (with a reason the popover shows):
// - spanning paragraphs: the engine writes one change inside one paragraph;
// - touching a pending <ins>/<del>: editing on top of it would silently accept
//   someone else's suggestion.

export type DocxSelection =
    | { ok: true; selected: string; contextBefore: string; contextAfter: string }
    | { ok: false; reason: string };

const CONTEXT_CHARS = 120;

function paragraphOf(node: Node, root: HTMLElement): HTMLElement | null {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const p = el?.closest("p");
    return p && root.contains(p) ? (p as HTMLElement) : null;
}

/** Text of a fragment with pending deletions removed. */
function acceptedText(fragment: DocumentFragment): string {
    fragment.querySelectorAll("del").forEach((d) => d.remove());
    return fragment.textContent ?? "";
}

export function captureDocxSelection(root: HTMLElement, range: Range): DocxSelection {
    const startP = paragraphOf(range.startContainer, root);
    const endP = paragraphOf(range.endContainer, root);
    if (!startP || !endP) return { ok: false, reason: "Pilih teks di dalam dokumen." };
    if (startP !== endP) return { ok: false, reason: "Pilih teks dalam satu paragraf untuk menyarankan perubahan." };

    for (const change of Array.from(startP.querySelectorAll("ins, del"))) {
        if (range.intersectsNode(change)) {
            return {
                ok: false,
                reason: "Teks ini sudah memiliki perubahan yang belum diputuskan. Terima atau tolak perubahan itu dulu.",
            };
        }
    }

    const doc = root.ownerDocument;
    const before = doc.createRange();
    before.setStart(startP, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = doc.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(startP, startP.childNodes.length);

    let selected = acceptedText(range.cloneContents());
    let contextBefore = acceptedText(before.cloneContents());
    let contextAfter = acceptedText(after.cloneContents());

    // Edge whitespace belongs to the context, so "Ganti" does not eat spaces.
    const lead = selected.match(/^\s*/)?.[0] ?? "";
    const trail = selected.match(/\s*$/)?.[0] ?? "";
    selected = selected.slice(lead.length, selected.length - trail.length);
    contextBefore += lead;
    contextAfter = trail + contextAfter;
    if (!selected) return { ok: false, reason: "Pilih teks di dalam dokumen." };

    return {
        ok: true,
        selected,
        contextBefore: contextBefore.slice(-CONTEXT_CHARS),
        contextAfter: contextAfter.slice(0, CONTEXT_CHARS),
    };
}

export type SuggestMode = "replace" | "delete" | "insert_after";

/** The replacement the backend expects for each mode (it diffs against the selection). */
export function replacementFor(mode: SuggestMode, selected: string, text: string): string {
    if (mode === "delete") return "";
    if (mode === "replace") return text;
    const added = text.trim();
    if (!added) return selected;
    const joiner = /^[\s.,;:)\]]/.test(added) || /\s$/.test(selected) ? "" : " ";
    return `${selected}${joiner}${added}`;
}
