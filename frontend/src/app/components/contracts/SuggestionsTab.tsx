"use client";

import { useState } from "react";
import { Check, Crosshair, PenLine, X } from "lucide-react";
import { resolveContractSuggestion } from "@/app/lib/vardaApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useReviewAccess } from "./reviewAccess";
import type { SuggestionRow } from "./reviewTypes";

// People's suggested edits (suggestion mode). Each one is already a tracked
// change in the working DOCX under its author's name; Terima keeps the new
// text, Tolak restores the original. Pending first, newest last within a group.

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch {
        return iso;
    }
}

const STATUS_LABEL: Record<SuggestionRow["status"], string> = {
    pending: "Menunggu keputusan",
    accepted: "Diterima",
    rejected: "Ditolak",
};

export interface SuggestionsTabProps {
    reviewId: string;
    suggestions: SuggestionRow[];
    hasDocx: boolean;
    onLocate: (s: SuggestionRow) => void;
    onResolved: (row: SuggestionRow) => void;
}

export function SuggestionsTab({ reviewId, suggestions, hasDocx, onLocate, onResolved }: SuggestionsTabProps) {
    const pending = suggestions.filter((s) => s.status === "pending");
    const decided = suggestions.filter((s) => s.status !== "pending");

    if (suggestions.length === 0) {
        return (
            <div className="flex flex-col items-center py-16 text-center text-sm text-gray-500">
                <PenLine className="mb-3 h-8 w-8 opacity-40" />
                <p className="font-medium text-gray-900">Belum ada saran perubahan</p>
                <p className="mt-1 max-w-xs">
                    {hasDocx
                        ? "Blok teks di dokumen lalu pilih “Sarankan perubahan”. Saran tampil sebagai coretan dan sisipan sampai diterima."
                        : "Saran langsung di dokumen membutuhkan DOCX asli. Unggah DOCX asli dari header tinjauan."}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {pending.length ? <p className="text-xs text-gray-500">{pending.length} saran menunggu keputusan</p> : null}
            {[...pending, ...decided].map((s) => (
                <SuggestionCard key={s.id} reviewId={reviewId} suggestion={s} onLocate={onLocate} onResolved={onResolved} />
            ))}
        </div>
    );
}

function SuggestionCard({
    reviewId,
    suggestion: s,
    onLocate,
    onResolved,
}: {
    reviewId: string;
    suggestion: SuggestionRow;
    onLocate: (s: SuggestionRow) => void;
    onResolved: (row: SuggestionRow) => void;
}) {
    const { canEdit } = useReviewAccess();
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const resolve = async (mode: "accept" | "reject") => {
        setBusy(mode);
        setError(null);
        try {
            onResolved(await resolveContractSuggestion(reviewId, s.id, mode));
        } catch (e) {
            setError(userFacingApiError(e, mode === "accept" ? "Gagal menerima saran." : "Gagal menolak saran."));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div
            className={`rounded-xl border bg-white p-3 text-sm ${s.status === "pending" ? "border-gray-200" : "border-gray-100 opacity-70"}`}
            data-testid={`suggestion-${s.id}`}
        >
            <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="font-medium text-gray-800">{s.author_name}</span>
                <span>· {formatDate(s.created_at)}</span>
                <span className="ml-auto">{STATUS_LABEL[s.status]}</span>
            </div>
            <p className="mt-2 leading-relaxed">
                {s.original_text ? <del className="text-red-700">{s.original_text}</del> : null}
                {s.original_text && s.suggested_text ? " " : null}
                {s.suggested_text ? <ins className="bg-emerald-100 text-emerald-800 no-underline">{s.suggested_text}</ins> : null}
            </p>
            {s.note ? <p className="mt-1.5 text-xs text-gray-600">{s.note}</p> : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => onLocate(s)}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                >
                    <Crosshair className="h-3 w-3" /> Lihat di dokumen
                </button>
                {s.status === "pending" && canEdit ? (
                    <>
                        <PillButtonUI tone="white" size="xs" className="ml-auto" onClick={() => void resolve("accept")} loading={busy === "accept"} disabled={busy !== null}>
                            <Check className="mr-1 h-3 w-3" /> Terima
                        </PillButtonUI>
                        <PillButtonUI tone="white" size="xs" onClick={() => void resolve("reject")} loading={busy === "reject"} disabled={busy !== null}>
                            <X className="mr-1 h-3 w-3" /> Tolak
                        </PillButtonUI>
                    </>
                ) : null}
            </div>
            {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
        </div>
    );
}
