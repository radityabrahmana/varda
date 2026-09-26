import { describe, expect, it } from "vitest";
import { anchorErrorMessage } from "./RevisionCard";

describe("anchorErrorMessage", () => {
    it("explains the redline engine's anchor errors in plain language", () => {
        expect(anchorErrorMessage('Could not locate find="x" in the document. Re-read the document.')).toBe(
            "Teks asli tidak ditemukan persis di dokumen, jadi perubahan ini belum masuk sebagai redline.",
        );
        expect(anchorErrorMessage('Ambiguous match for find="x". Add longer context.')).toBe(
            "Teks asli muncul lebih dari satu kali di dokumen, jadi perubahan ini belum masuk sebagai redline.",
        );
        expect(anchorErrorMessage("Overlaps a previous edit in the same paragraph.")).toBe(
            "Perubahan ini belum masuk sebagai redline di dokumen.",
        );
    });
});
