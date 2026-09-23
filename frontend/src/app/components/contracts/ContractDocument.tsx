"use client";

import { useEffect, useRef } from "react";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { clearDocxQuoteHighlights, highlightDocxQuote } from "@/app/components/shared/views/highlightDocxQuote";
import { getContractFileUrl, getContractTrackedChangeIdsUrl } from "@/app/lib/mikeApi";
import { ContractHtmlView } from "./ContractHtmlView";
import type { ReviewDetailRow } from "./reviewTypes";

// Left pane of the workspace. Reviews with a persisted original render the real
// DOCX through Varda's viewer (tracked changes render natively); older reviews
// fall back to the sanitized mammoth HTML. Both support "Lihat di dokumen":
// the active finding's highlight_text is located with Varda's quote matcher.

export interface ContractDocumentProps {
    review: ReviewDetailRow;
    activeQuote: string | null;
    quoteFocusKey: number;
    /** Bump after the working DOCX changed server-side (accept / reject / edit). */
    refetchKey?: number;
    /** Tracked change to scroll to and flash (a suggestion's "Lihat di dokumen"). */
    highlightEdit?: { key: string; ins_w_id?: string | null; del_w_id?: string | null; inserted_text?: string; deleted_text?: string } | null;
}

export function ContractDocument({ review, activeQuote, quoteFocusKey, refetchKey, highlightEdit }: ContractDocumentProps) {
    if (review.contract_docx_path) {
        return (
            <DocxView
                documentId={review.id}
                displayUrl={getContractFileUrl(review.id)}
                refetchKey={refetchKey}
                trackedChangeIdsUrl={getContractTrackedChangeIdsUrl(review.id)}
                highlightEdit={highlightEdit}
                quotes={activeQuote ? [{ quote: activeQuote }] : undefined}
                quoteFocusKey={quoteFocusKey}
                rounded={false}
            />
        );
    }
    return <HtmlWithQuote review={review} activeQuote={activeQuote} quoteFocusKey={quoteFocusKey} />;
}

function HtmlWithQuote({ review, activeQuote, quoteFocusKey }: ContractDocumentProps) {
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        clearDocxQuoteHighlights(root);
        if (!activeQuote) return;
        const match = highlightDocxQuote(root, activeQuote);
        match?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [activeQuote, quoteFocusKey, review.contract_html]);

    return (
        <div ref={rootRef}>
            <ContractHtmlView html={review.contract_html} text={review.contract_text} />
        </div>
    );
}
