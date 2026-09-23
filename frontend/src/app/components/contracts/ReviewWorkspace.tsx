"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { Download, FileDiff, Link2, Upload } from "lucide-react";
import { MikeApiError, attachContractDocx, generateContractMemo, getContract, getContractDownloadUrl, patchContract, projectContractRedline, type ContractPatch } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ContractDocument } from "./ContractDocument";
import { DraftFindings } from "./DraftFindings";
import { StatusPill } from "./StatusPill";
import { NegotiationTab } from "./NegotiationTab";
import { TabularFindings } from "./TabularFindings";
import { CommentsTab } from "./CommentsTab";
import { AddCommentPopover, type SelectionAnchor } from "./AddCommentPopover";
import { buildAnnotations } from "./findingAnnotations";
import { PlaybookDrawerProvider } from "@/app/components/playbook/PlaybookRuleDrawer";
import type { ContractReviewDetail, ManualCommentRow, NegotiationPointRow, ReviewDetailRow, ReviewFeedbackRow, ReviewOutput, RevisionEditRow } from "./reviewTypes";
import { feedbackKey } from "./reviewTypes";
import { RISK_DOT } from "./reviewHelpers";
import { RECOMMENDATION_PILL, RISK_HEADER_LABEL, formatCreatedAt } from "./reviewLabels";

type LoadState =
    | { kind: "loading" }
    | { kind: "not_found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: ContractReviewDetail };

/** Feedback keys that count toward "reviewed": one per finding the Draf view asks about. */
export function reviewableKeys(output: ReviewOutput): string[] {
    return [
        feedbackKey("executive_summary", "overall_recommendation"),
        ...Object.keys(output.playbook_compliance ?? {}).map((slug) => feedbackKey("playbook_rule", slug)),
        ...output.red_flags.map((f) => feedbackKey("red_flag", f.id)),
        ...output.revisions.map((r) => feedbackKey("revision", r.id)),
        ...output.clarifications.map((c) => feedbackKey("clarification", c.id)),
        ...output.financial_review.map((_, i) => feedbackKey("financial", `FIN-${i}`)),
        ...output.missing_clauses.map((_, i) => feedbackKey("missing_clause", `MC-${i}`)),
    ];
}

const GATE_LOCKED_STATUSES = new Set(["clevel_reviewed", "signed", "archived"]);

type PanelTab = "draft" | "comments" | "table" | "negotiation";
/** Below `lg` the document and the findings panel do not fit side by side; one is shown at a time. */
type MobileView = "document" | "findings";
/** Tabs that show the review-progress footer with the C-Level gate. */
const GATE_TABS = new Set<PanelTab>(["draft", "table"]);
const MIN_SELECTION_CHARS = 5;

export function ReviewWorkspace({ reviewId }: { reviewId: string }) {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [gateBusy, setGateBusy] = useState(false);
    const [docRefetchKey, setDocRefetchKey] = useState(0);
    const [panelTab, setPanelTab] = useState<PanelTab>("draft");
    const [mobileView, setMobileView] = useState<MobileView>("findings");
    const [commentAnchor, setCommentAnchor] = useState<SelectionAnchor | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const docPaneRef = useRef<HTMLDivElement>(null);
    const [memoGenerating, setMemoGenerating] = useState(false);
    const [memoError, setMemoError] = useState<string | null>(null);
    const [projecting, setProjecting] = useState(false);
    const [projectMessage, setProjectMessage] = useState<string | null>(null);
    const [shareMessage, setShareMessage] = useState<string | null>(null);
    const [attachingDocx, setAttachingDocx] = useState(false);
    const [attachMessage, setAttachMessage] = useState<string | null>(null);
    const docxInputRef = useRef<HTMLInputElement>(null);
    // Shown when the clipboard is blocked (embedded browsers, strict policies) so the
    // link can still be copied by hand.
    const [shareFallbackUrl, setShareFallbackUrl] = useState<string | null>(null);
    const [activeQuote, setActiveQuote] = useState<string | null>(null);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const locate = useCallback((text: string) => {
        setActiveQuote(text);
        setQuoteFocusKey((k) => k + 1);
        setMobileView("document");
    }, []);
    const [gateMessage, setGateMessage] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        getContract(reviewId)
            .then((detail) => {
                if (!cancelled) setState({ kind: "ready", detail });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                if (error instanceof MikeApiError && error.status === 404) setState({ kind: "not_found" });
                else setState({ kind: "error", message: "Tinjauan tidak dapat dimuat. Coba lagi." });
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, reviewId]);

    const detail = state.kind === "ready" ? state.detail : null;
    const review = detail?.review ?? null;
    const output = review?.ai_output ?? null;

    const feedbackMap = useMemo(() => {
        const map = new Map<string, ReviewFeedbackRow>();
        for (const row of detail?.feedback ?? []) map.set(feedbackKey(row.finding_type, row.finding_id), row);
        return map;
    }, [detail?.feedback]);

    const onFeedbackSaved = useCallback((row: ReviewFeedbackRow) => {
        setState((prev) =>
            prev.kind === "ready" ? { kind: "ready", detail: { ...prev.detail, feedback: [...prev.detail.feedback, row] } } : prev,
        );
    }, []);

    const onFeedbackSavedBulk = useCallback((rows: ReviewFeedbackRow[]) => {
        setState((prev) =>
            prev.kind === "ready" ? { kind: "ready", detail: { ...prev.detail, feedback: [...prev.detail.feedback, ...rows] } } : prev,
        );
    }, []);

    const onCommentSaved = useCallback((row: ManualCommentRow) => {
        setState((prev) =>
            prev.kind === "ready" ? { kind: "ready", detail: { ...prev.detail, comments: [...prev.detail.comments, row] } } : prev,
        );
        setNotice(row.parent_comment_id ? "Balasan tersimpan" : "Komentar tersimpan");
    }, []);

    const onSignalSaved = useCallback(() => {
        setNotice("Sinyal pelatihan tersimpan. Tinjauan berikutnya untuk klien/jenis dokumen serupa akan memperhatikan pola ini.");
    }, []);

    // Selecting text in the document pane opens the comment popover (Janus:
    // "Tinjauan AI" selection → AddCommentPopover). Offsets come from
    // contract_text so a comment stays anchored across viewer implementations.
    const handleDocMouseUp = useCallback(() => {
        const pane = docPaneRef.current;
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (!pane || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
        if (!pane.contains(sel.anchorNode) || !pane.contains(sel.focusNode)) return;
        const text = sel.toString().trim();
        if (text.length < MIN_SELECTION_CHARS) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        const start = review?.contract_text?.indexOf(text) ?? -1;
        setCommentAnchor({
            text,
            start,
            end: start >= 0 ? start + text.length : -1,
            position: {
                top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 380)),
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)),
            },
        });
    }, [review?.contract_text]);

    const onReviewPatched = useCallback((patch: Partial<ReviewDetailRow> | ContractPatch) => {
        setState((prev) =>
            prev.kind === "ready"
                ? { kind: "ready", detail: { ...prev.detail, review: { ...prev.detail.review, ...(patch as Partial<ReviewDetailRow>) } } }
                : prev,
        );
    }, []);

    const editsByRevision = useMemo(() => {
        const map = new Map<string, RevisionEditRow>();
        for (const e of detail?.revisionEdits ?? []) map.set(e.revision_id, e);
        return map;
    }, [detail?.revisionEdits]);

    const onRevisionResolved = useCallback((edit: RevisionEditRow, feedback: ReviewFeedbackRow) => {
        setState((prev) => {
            if (prev.kind !== "ready") return prev;
            const edits = prev.detail.revisionEdits.some((e) => e.id === edit.id)
                ? prev.detail.revisionEdits.map((e) => (e.id === edit.id ? edit : e))
                : [...prev.detail.revisionEdits, edit];
            return { kind: "ready", detail: { ...prev.detail, revisionEdits: edits, feedback: [...prev.detail.feedback, feedback] } };
        });
        // The working DOCX changed on the server; make the viewer refetch it.
        setDocRefetchKey((k) => k + 1);
    }, []);

    // Reps paste this into Slack; the recipient logs in and lands on this contract.
    const shareLink = async () => {
        if (!review) return;
        const url = `${window.location.origin}/contracts/${review.id}`;
        try {
            await navigator.clipboard.writeText(url);
            setShareFallbackUrl(null);
            setShareMessage("Tautan disalin");
            window.setTimeout(() => setShareMessage(null), 3000);
        } catch {
            setShareMessage(null);
            setShareFallbackUrl(url);
        }
    };

    // Repair: the original DOCX was not persisted at creation (storage hiccup or a
    // retried upload), so the workspace is in HTML-only mode without redlines.
    const attachDocx = async (file: File) => {
        if (!review) return;
        setAttachingDocx(true);
        setAttachMessage(null);
        try {
            const result = await attachContractDocx(review.id, file);
            const detail = await getContract(review.id);
            setState({ kind: "ready", detail });
            setDocRefetchKey((k) => k + 1);
            const projected = result.projection?.projected ?? 0;
            setAttachMessage(projected ? `DOCX tersimpan; ${projected} revisi dipetakan ke dokumen.` : "DOCX tersimpan.");
        } catch (e) {
            setAttachMessage(userFacingApiError(e, "Gagal menyimpan DOCX."));
        } finally {
            setAttachingDocx(false);
            if (docxInputRef.current) docxInputRef.current.value = "";
        }
    };

    const projectRedline = async () => {
        if (!review) return;
        setProjecting(true);
        setProjectMessage(null);
        try {
            const result = await projectContractRedline(review.id);
            setState((prev) =>
                prev.kind === "ready"
                    ? { kind: "ready", detail: { ...prev.detail, revisionEdits: result.edits, review: { ...prev.detail.review, contract_redline_path: result.projected > 0 ? `contracts/${review.id}/redline.docx` : prev.detail.review.contract_redline_path } } }
                    : prev,
            );
            setDocRefetchKey((k) => k + 1);
            setProjectMessage(`${result.projected} revisi dipetakan ke dokumen${result.failed ? `, ${result.failed} tidak dapat dipetakan` : ""}.`);
        } catch {
            setProjectMessage("Gagal memetakan revisi ke dokumen.");
        } finally {
            setProjecting(false);
        }
    };

    const generateMemo = useCallback(async (reviewId: string) => {
        setMemoGenerating(true);
        setMemoError(null);
        setPanelTab("negotiation");
        try {
            const result = await generateContractMemo(reviewId);
            setState((prev) =>
                prev.kind === "ready"
                    ? { kind: "ready", detail: { ...prev.detail, review: { ...prev.detail.review, negotiation_memo: result.memo, negotiation_memo_generated_at: result.generated_at } } }
                    : prev,
            );
        } catch (e) {
            setMemoError(userFacingApiError(e, "Gagal membuat memo negosiasi"));
        } finally {
            setMemoGenerating(false);
        }
    }, []);

    const onPointSaved = useCallback((row: NegotiationPointRow) => {
        setState((prev) => {
            if (prev.kind !== "ready") return prev;
            const rest = prev.detail.negotiationPoints.filter((p) => p.point_id !== row.point_id);
            return { kind: "ready", detail: { ...prev.detail, negotiationPoints: [...rest, row] } };
        });
    }, []);

    const annotations = useMemo(
        () => (output ? buildAnnotations({ output, comments: detail?.comments ?? [], feedbackMap, contractText: review?.contract_text ?? null }) : []),
        [output, detail?.comments, feedbackMap, review?.contract_text],
    );
    const rootCommentCount = useMemo(() => (detail?.comments ?? []).filter((c) => !c.parent_comment_id).length, [detail?.comments]);

    const progress = useMemo(() => {
        if (!output) return null;
        const keys = reviewableKeys(output);
        const reviewed = keys.filter((k) => feedbackMap.has(k)).length;
        return { total: keys.length, reviewed, percent: keys.length ? Math.round((reviewed / keys.length) * 100) : 0 };
    }, [output, feedbackMap]);

    const allReviewed = Boolean(progress && progress.total > 0 && progress.reviewed >= progress.total);
    const gateLocked = Boolean(review?.status && GATE_LOCKED_STATUSES.has(review.status));
    const alreadyReviewed = review?.status === "clevel_reviewed" || review?.status === "signed";

    const markCLevelReviewed = async () => {
        if (!review) return;
        setGateBusy(true);
        setGateMessage(null);
        try {
            const saved = await patchContract(review.id, { status: "clevel_reviewed", lifecycle_stage: "clevel_review" });
            onReviewPatched(saved);
            setGateMessage("Status diperbarui ke Ditinjau C-Level");
            // Janus: the hand-off to BD starts here — the memo is generated right away.
            void generateMemo(review.id);
        } catch {
            setGateMessage("Gagal memperbarui status. Coba lagi.");
        } finally {
            setGateBusy(false);
        }
    };

    const recommendation = review?.coo_recommendation_override ?? output?.overall_recommendation ?? null;

    return (
        <PlaybookDrawerProvider>
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                loading={state.kind === "loading"}
                breadcrumbs={[
                    { label: "Contracts", onClick: () => router.push("/contracts"), title: "Kembali ke Tinjauan Kontrak" },
                    state.kind === "loading" ? { loading: true, skeletonClassName: "w-40" } : { label: review?.title ?? "Tinjauan" },
                ]}
            />

            {state.kind === "loading" ? (
                <div className="p-8 text-sm text-gray-500">Memuat tinjauan...</div>
            ) : state.kind === "not_found" ? (
                <div className="p-8 text-sm text-gray-500">Tinjauan tidak ditemukan</div>
            ) : state.kind === "error" ? (
                <div className="p-8 text-sm text-red-600">{state.message}</div>
            ) : !review || !output ? (
                <div className="p-8 text-sm text-gray-500">
                    {review?.status === "failed" ? "Tinjauan gagal diproses. Unggah ulang kontrak." : "Tinjauan masih diproses..."}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 sm:gap-3 sm:px-6">
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate font-serif text-xl font-medium text-gray-900">{review.title}</h1>
                            <p className="mt-0.5 text-xs text-gray-500">
                                {review.document_type} · {review.client_name}
                                {review.created_at ? ` · Dibuat ${formatCreatedAt(review.created_at)}` : ""}
                            </p>
                        </div>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-800">
                            <span className="h-2 w-2 rounded-full" style={{ background: RISK_DOT[output.risk_level] ?? "#9CA3AF" }} />
                            {RISK_HEADER_LABEL[output.risk_level] ?? output.risk_level}
                        </span>
                        {recommendation ? (
                            <span className="inline-flex items-center rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold tracking-wide text-white">
                                {RECOMMENDATION_PILL[recommendation] ?? recommendation}
                            </span>
                        ) : null}
                        <StatusPill review={review} onUpdate={onReviewPatched} />
                        <PillButtonUI tone="white" size="xs" onClick={() => void shareLink()} title="Salin tautan tinjauan ini untuk dibagikan di Slack">
                            <Link2 className="mr-1 h-3 w-3" /> Bagikan
                        </PillButtonUI>
                        {shareMessage ? <span className="text-xs text-gray-600" role="status">{shareMessage}</span> : null}
                        {shareFallbackUrl ? (
                            <label className="flex items-center gap-1.5 text-xs text-gray-600" role="status">
                                Salin manual:
                                <input
                                    readOnly
                                    autoFocus
                                    value={shareFallbackUrl}
                                    aria-label="Tautan tinjauan"
                                    onFocus={(e) => e.currentTarget.select()}
                                    onBlur={() => setShareFallbackUrl(null)}
                                    className="w-72 max-w-full rounded border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-800"
                                />
                            </label>
                        ) : null}
                        {review.contract_docx_path ? (
                            <a
                                href={getContractDownloadUrl(review.id)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-200 px-3 text-xs font-medium text-gray-800 hover:bg-gray-50"
                                title={review.contract_redline_path ? "Unduh kontrak redline (DOCX)" : "Unduh kontrak asli (DOCX)"}
                            >
                                <Download className="h-3.5 w-3.5" /> Ekspor
                            </a>
                        ) : null}
                        {!review.contract_docx_path ? (
                            <>
                                <input
                                    ref={docxInputRef}
                                    type="file"
                                    accept=".docx"
                                    className="hidden"
                                    aria-label="Pilih file DOCX asli"
                                    onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) void attachDocx(f);
                                    }}
                                />
                                <PillButtonUI
                                    tone="white"
                                    size="xs"
                                    onClick={() => docxInputRef.current?.click()}
                                    loading={attachingDocx}
                                    title="DOCX asli belum tersimpan, sehingga redline tidak dapat ditampilkan. Unggah ulang file kontraknya."
                                >
                                    <Upload className="mr-1 h-3 w-3" /> Unggah DOCX asli
                                </PillButtonUI>
                            </>
                        ) : null}
                        {attachMessage ? <span className="text-xs text-gray-600" role="status">{attachMessage}</span> : null}
                        {review.contract_docx_path && (output.revisions.length > editsByRevision.size) ? (
                            <PillButtonUI tone="white" size="xs" onClick={projectRedline} loading={projecting}>
                                <FileDiff className="mr-1 h-3 w-3" /> Petakan revisi ke dokumen
                            </PillButtonUI>
                        ) : null}
                        {projectMessage ? <span className="text-xs text-gray-600" role="status">{projectMessage}</span> : null}
                    </div>

                    <div className="flex gap-1 border-b border-gray-200 bg-white px-4 py-2 lg:hidden" role="tablist" aria-label="Tampilan">
                        {(
                            [
                                { id: "findings", label: "Temuan" },
                                { id: "document", label: "Dokumen" },
                            ] as { id: MobileView; label: string }[]
                        ).map((view) => (
                            <button
                                key={view.id}
                                type="button"
                                role="tab"
                                aria-selected={mobileView === view.id}
                                onClick={() => setMobileView(view.id)}
                                className={`flex-1 rounded-full px-3 py-1.5 text-sm ${mobileView === view.id ? "bg-gray-900 font-medium text-white" : "text-gray-600 hover:bg-gray-100"}`}
                            >
                                {view.label}
                            </button>
                        ))}
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                        {/* DocxView scrolls inside its own container only when it is a
                            height-constrained flex item (its root is `flex-1 overflow-hidden`).
                            As a plain block the viewer grows to the full document height,
                            the pane clips it, and multi-page contracts cannot be scrolled. */}
                        <div
                            ref={docPaneRef}
                            onMouseUp={handleDocMouseUp}
                            data-testid="document-pane"
                            className={
                                review.contract_docx_path
                                    ? `${mobileView === "document" ? "flex" : "hidden"} min-h-0 flex-1 flex-col overflow-hidden lg:flex`
                                    : `${mobileView === "document" ? "block" : "hidden"} min-h-0 flex-1 overflow-y-auto bg-gray-100 p-4 sm:p-6 lg:block`
                            }
                        >
                            <ContractDocument review={review} activeQuote={activeQuote} quoteFocusKey={quoteFocusKey} refetchKey={docRefetchKey} />
                        </div>
                        <aside
                            data-testid="findings-pane"
                            className={`${mobileView === "findings" ? "flex" : "hidden"} min-h-0 w-full flex-1 flex-col bg-gray-50 lg:flex lg:w-[440px] lg:flex-none lg:border-l lg:border-gray-200 xl:w-[500px]`}
                        >
                            <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 bg-white px-3 pt-2" role="tablist">
                                {(
                                    [
                                        { id: "draft", label: "Draf", disabled: false },
                                        { id: "comments", label: rootCommentCount ? `Komentar (${rootCommentCount})` : "Komentar", disabled: false },
                                        { id: "table", label: "Tabel", disabled: false },
                                        { id: "negotiation", label: "Negosiasi", disabled: !review.negotiation_memo && !memoGenerating },
                                    ] as { id: PanelTab; label: string; disabled: boolean }[]
                                ).map((tab) => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={panelTab === tab.id}
                                        disabled={tab.disabled}
                                        onClick={() => setPanelTab(tab.id)}
                                        className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${panelTab === tab.id ? "border-gray-900 font-medium text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"} disabled:cursor-not-allowed disabled:opacity-40`}
                                        title={tab.disabled ? "Memo negosiasi belum tersedia" : undefined}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                            {notice ? (
                                <div className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800" role="status">
                                    <span className="flex-1">{notice}</span>
                                    <button type="button" onClick={() => setNotice(null)} aria-label="Tutup" className="text-emerald-700 hover:text-emerald-900">×</button>
                                </div>
                            ) : null}
                            <div className={GATE_TABS.has(panelTab) ? "min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pb-28 sm:p-5 sm:pb-28" : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5"}>
                                {panelTab === "comments" ? (
                                    <CommentsTab
                                        reviewId={review.id}
                                        comments={state.detail.comments}
                                        contractText={review.contract_text}
                                        onLocate={locate}
                                        onCommentSaved={onCommentSaved}
                                    />
                                ) : panelTab === "table" ? (
                                    <TabularFindings reviewId={review.id} annotations={annotations} onLocate={locate} onFeedbackSaved={onFeedbackSavedBulk} />
                                ) : panelTab === "negotiation" ? (
                                    <NegotiationTab
                                        reviewId={review.id}
                                        clientName={review.client_name}
                                        memo={review.negotiation_memo}
                                        generatedAt={review.negotiation_memo_generated_at}
                                        generating={memoGenerating}
                                        error={memoError}
                                        points={state.detail.negotiationPoints}
                                        onRegenerate={() => void generateMemo(review.id)}
                                        onPointSaved={onPointSaved}
                                    />
                                ) : (
                                <DraftFindings
                                    review={review}
                                    output={output}
                                    feedbackMap={feedbackMap}
                                    onFeedbackSaved={onFeedbackSaved}
                                    onReviewPatched={onReviewPatched}
                                    onLocate={locate}
                                    editsByRevision={editsByRevision}
                                    onRevisionResolved={onRevisionResolved}
                                />
                                )}
                            </div>
                            {progress && GATE_TABS.has(panelTab) ? (
                                <div className="border-t border-gray-200 bg-white px-5 py-3">
                                    <div className="flex items-center justify-between text-xs text-gray-600">
                                        <span data-testid="progress-label">
                                            {progress.reviewed} dari {progress.total} temuan ditinjau
                                        </span>
                                        <span>{progress.percent}%</span>
                                    </div>
                                    <div className="mt-1.5 h-[3px] w-full rounded bg-gray-200">
                                        <div
                                            className="h-[3px] rounded"
                                            style={{ width: `${progress.percent}%`, background: progress.percent === 100 ? "#16A34A" : "#111827" }}
                                        />
                                    </div>
                                    <div className="mt-3 flex items-center gap-3">
                                        <PillButtonUI
                                            tone="black"
                                            size="sm"
                                            onClick={markCLevelReviewed}
                                            disabled={!allReviewed || gateLocked}
                                            loading={gateBusy}
                                        >
                                            {alreadyReviewed ? "Ditinjau C-Level ✓" : "Tandai Sudah Ditinjau C-Level"}
                                        </PillButtonUI>
                                        {gateMessage ? <span className="text-xs text-gray-600" role="status">{gateMessage}</span> : null}
                                    </div>
                                </div>
                            ) : null}
                        </aside>
                    </div>
                    {commentAnchor ? (
                        <AddCommentPopover
                            reviewId={review.id}
                            anchor={commentAnchor}
                            onClose={() => setCommentAnchor(null)}
                            onCommentSaved={onCommentSaved}
                            onSignalSaved={onSignalSaved}
                        />
                    ) : null}
                </>
            )}
        </div>
        </PlaybookDrawerProvider>
    );
}
