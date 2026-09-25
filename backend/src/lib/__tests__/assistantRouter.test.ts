import { describe, expect, it } from "vitest";
import {
    hasDeepIntent,
    LONG_PROMPT_CHARS,
    routeTurn,
    type TurnSignals,
} from "../llm/router";

function signals(overrides: Partial<TurnSignals> = {}): TurnSignals {
    return {
        userTexts: ["What does this term mean?"],
        workflowApplied: false,
        attachedDocumentCount: 0,
        ...overrides,
    };
}

describe("routeTurn", () => {
    it("pins the tier for Fast and Deep whatever the conversation holds", () => {
        const heavy = signals({ workflowApplied: true, attachedDocumentCount: 5 });
        expect(routeTurn("fast", heavy)).toEqual({ tier: "fast", reason: "mode_fast" });
        expect(routeTurn("deep", signals())).toEqual({ tier: "deep", reason: "mode_deep" });
    });

    it("keeps a short question on the fast tier", () => {
        expect(routeTurn("auto", signals())).toEqual({ tier: "fast", reason: "default" });
    });

    it.each<[string, Partial<TurnSignals>, string]>([
        ["an applied workflow", { workflowApplied: true }, "workflow"],
        ["two attached documents", { attachedDocumentCount: 2 }, "multiple_documents"],
        ["a long prompt", { userTexts: ["x".repeat(LONG_PROMPT_CHARS)] }, "long_prompt"],
        ["a review request", { userTexts: ["Tolong tinjau kontrak ini"] }, "deep_intent"],
    ])("sends %s to the deep tier", (_label, overrides, reason) => {
        expect(routeTurn("auto", signals(overrides))).toEqual({ tier: "deep", reason });
    });

    it("keeps one attached document on the fast tier", () => {
        expect(routeTurn("auto", signals({ attachedDocumentCount: 1 })).tier).toBe("fast");
    });

    it("stays deep once any earlier turn earned it", () => {
        const decision = routeTurn(
            "auto",
            signals({ userTexts: ["Draft an NDA for a supplier", "thanks!"] }),
        );
        expect(decision).toEqual({ tier: "deep", reason: "deep_intent" });
    });
});

describe("hasDeepIntent", () => {
    it.each([
        "Tolong tinjau perjanjian ini",
        "bisa ditelaah pasal 5?",
        "menganalisis risiko wanprestasi",
        "rancangkan somasi untuk vendor",
        "Please review the indemnity clause",
        "compare these two drafts",
    ])("recognises %j", (text) => {
        expect(hasDeepIntent(text)).toBe(true);
    });

    it.each([
        "Apa arti force majeure?",
        "translate this sentence to English",
        "show me a preview of the letter",
        "halo",
    ])("does not flag %j", (text) => {
        expect(hasDeepIntent(text)).toBe(false);
    });
});
