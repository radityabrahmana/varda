import type { AssistantMode, ModelTier } from "./types";

// Picks the tier that serves an Assistant turn. Pure and synchronous on
// purpose: it runs before every routed turn, and a rule table is something a
// reviewer can read and a test can pin. A learned classifier can replace
// `autoTier` later without changing callers.
//
// Every signal is taken over the WHOLE conversation, never just the latest
// message. That makes Auto monotonic: once a chat has earned the deep tier it
// keeps it, which keeps the provider's prompt cache warm and the answer style
// consistent instead of flip-flopping between models turn by turn.

export type TurnSignals = {
    /** Text the person wrote, oldest first, without attachment/workflow markers. */
    userTexts: string[];
    /** A workflow was applied somewhere in the conversation. */
    workflowApplied: boolean;
    /** Distinct documents attached across the conversation. */
    attachedDocumentCount: number;
};

export type RouteReason =
    | "mode_fast"
    | "mode_deep"
    | "workflow"
    | "multiple_documents"
    | "long_prompt"
    | "deep_intent"
    | "default";

export type RouteDecision = { tier: ModelTier; reason: RouteReason };

/** A prompt this long is usually a pasted clause or a detailed brief. */
export const LONG_PROMPT_CHARS = 1500;

// Asking for analysis, drafting, review or comparison. Indonesian verbs take
// prefixes (meninjau, ditelaah, menganalisis, merancang), so those stems match
// anywhere in a word; the English words match whole words only.
const DEEP_INTENT_STEMS =
    /(tinjau|telaah|analisis|analisa|rancang|bandingk|susunk|redline|revisi|risiko|klausul|somasi|gugatan|legal opinion|pendapat hukum)/i;
const DEEP_INTENT_WORDS =
    /\b(review|analy[sz]e|analysis|draft(ing)?|redraft|compare|comparison|negotiat\w*|risks?|clauses?|liabilit(y|ies)|indemnit(y|ies))\b/i;

export function hasDeepIntent(text: string): boolean {
    return DEEP_INTENT_STEMS.test(text) || DEEP_INTENT_WORDS.test(text);
}

function autoTier(signals: TurnSignals): RouteDecision {
    if (signals.workflowApplied) return { tier: "deep", reason: "workflow" };
    if (signals.attachedDocumentCount >= 2) {
        return { tier: "deep", reason: "multiple_documents" };
    }
    if (signals.userTexts.some((text) => text.length >= LONG_PROMPT_CHARS)) {
        return { tier: "deep", reason: "long_prompt" };
    }
    if (signals.userTexts.some(hasDeepIntent)) {
        return { tier: "deep", reason: "deep_intent" };
    }
    return { tier: "fast", reason: "default" };
}

export function routeTurn(
    mode: AssistantMode,
    signals: TurnSignals,
): RouteDecision {
    if (mode === "fast") return { tier: "fast", reason: "mode_fast" };
    if (mode === "deep") return { tier: "deep", reason: "mode_deep" };
    return autoTier(signals);
}
