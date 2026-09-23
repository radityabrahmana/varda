"use client";

import { useState } from "react";
import { postContractSuggestion } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { replacementFor, type SuggestMode } from "./docxSelection";
import type { SuggestionRow } from "./reviewTypes";

// Suggestion mode body of the selection popover: the selection becomes a
// tracked change under the caller's name (like Word "Suggesting"). Nothing is
// removed until someone clicks Terima on the suggestion.

const MODES: { value: SuggestMode; label: string }[] = [
    { value: "replace", label: "Ganti" },
    { value: "delete", label: "Hapus" },
    { value: "insert_after", label: "Sisipkan setelahnya" },
];

export interface SuggestEditFormProps {
    reviewId: string;
    selected: string;
    contextBefore: string;
    contextAfter: string;
    onSaved: (row: SuggestionRow) => void;
    onClose: () => void;
}

export function SuggestEditForm({ reviewId, selected, contextBefore, contextAfter, onSaved, onClose }: SuggestEditFormProps) {
    const [mode, setMode] = useState<SuggestMode>("replace");
    const [text, setText] = useState(selected);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const replacement = replacementFor(mode, selected, text);
    const unchanged = replacement === selected;

    const switchMode = (next: SuggestMode) => {
        setMode(next);
        setText(next === "replace" ? selected : "");
        setError(null);
    };

    const save = async () => {
        if (unchanged) return;
        setBusy(true);
        setError(null);
        try {
            const row = await postContractSuggestion(reviewId, {
                selected_text: selected,
                replacement,
                context_before: contextBefore,
                context_after: contextAfter,
                note: note.trim() || null,
            });
            onSaved(row);
            onClose();
        } catch (e) {
            setError(userFacingApiError(e, "Saran gagal disimpan."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2.5">
            <div className="flex gap-1" role="radiogroup" aria-label="Jenis saran">
                {MODES.map((m) => (
                    <button
                        key={m.value}
                        type="button"
                        role="radio"
                        aria-checked={mode === m.value}
                        onClick={() => switchMode(m.value)}
                        className={`rounded-full px-2.5 py-1 text-xs ${mode === m.value ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-700 hover:bg-gray-50"}`}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            {mode !== "delete" ? (
                <textarea
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={3}
                    aria-label={mode === "replace" ? "Teks pengganti" : "Teks yang disisipkan"}
                    placeholder={mode === "replace" ? "Tulis teks pengganti..." : "Tulis teks yang ditambahkan..."}
                    className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-gray-400 focus:outline-none"
                />
            ) : null}
            <div className="rounded bg-gray-50 p-2 text-xs leading-relaxed text-gray-700" data-testid="suggestion-preview">
                {mode === "insert_after" ? (
                    <>
                        <span>{selected}</span>
                        {text.trim() ? <ins className="bg-emerald-100 text-emerald-800 no-underline"> {text.trim()}</ins> : null}
                    </>
                ) : (
                    <>
                        <del className="text-red-700">{selected}</del>
                        {mode === "replace" && text && text !== selected ? (
                            <ins className="ml-1 bg-emerald-100 text-emerald-800 no-underline">{text}</ins>
                        ) : null}
                    </>
                )}
            </div>
            <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                aria-label="Catatan (opsional)"
                placeholder="Alasan (opsional, hanya terlihat di Varda)"
                className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-gray-400 focus:outline-none"
            />
            <div className="flex items-center gap-2">
                <PillButtonUI tone="black" size="xs" onClick={() => void save()} loading={busy} disabled={busy || unchanged}>
                    Sarankan
                </PillButtonUI>
                <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">Batal</button>
                {error ? <span className="text-xs text-red-600">{error}</span> : null}
            </div>
        </div>
    );
}
