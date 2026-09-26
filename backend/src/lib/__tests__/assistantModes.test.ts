import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    availableTierModels,
    concreteModelForChat,
    hasApiKeyForModel,
    resolveEffectiveChatModel,
    servingModelsForMode,
    titleModelForChat,
} from "../modelSelection";
import { resolveModel } from "../llm/models";
import { resetModelRegistryCache } from "../llm/registry";
import type { Db } from "../supabase";

const db = {} as Db;

afterEach(() => {
    delete process.env.VARDA_MODEL_CONFIG_JSON;
    resetModelRegistryCache();
});

function configureTiers(tiers: Record<string, string[]>) {
    process.env.VARDA_MODEL_CONFIG_JSON = JSON.stringify({ tiers });
    resetModelRegistryCache();
}

describe("mode ids", () => {
    it("are not catalog models", () => {
        // Only mode-aware callers may accept them; a tabular review or a
        // title override that received one must fall back, not run it.
        expect(resolveModel("varda/auto", "fallback")).toBe("fallback");
    });
});

describe("tier availability", () => {
    it("keeps the built-in order and skips models without a key", () => {
        expect(availableTierModels("deep", { claude: "k", gemini: "k" })).toEqual([
            "claude-sonnet-5",
            "gemini-3.1-pro-preview",
        ]);
        expect(availableTierModels("deep", { openai: "k" })).toEqual(["gpt-5.6-sol"]);
    });

    it("uses the deployment's tiers and skips entries it cannot resolve", () => {
        configureTiers({
            fast: ["not-a-model", "openrouter/google/gemini-3-flash"],
            deep: ["openrouter/anthropic/claude-sonnet-5"],
        });
        expect(availableTierModels("fast", { openrouter: "k" })).toEqual([
            "openrouter/google/gemini-3-flash",
        ]);
        expect(availableTierModels("deep", {})).toEqual([]);
    });

    it("lets Auto borrow the other tier, but never Fast or Deep", () => {
        const onlyClaude = { claude: "k" };
        configureTiers({ fast: ["gemini-3-flash-preview"], deep: ["claude-sonnet-5"] });
        expect(servingModelsForMode("auto", "fast", onlyClaude)).toEqual({
            tier: "deep",
            models: ["claude-sonnet-5"],
        });
        expect(servingModelsForMode("fast", "fast", onlyClaude)).toEqual({
            tier: "fast",
            models: [],
        });
        expect(hasApiKeyForModel("varda/auto", onlyClaude)).toBe(true);
        expect(hasApiKeyForModel("varda/fast", onlyClaude)).toBe(false);
        expect(hasApiKeyForModel("varda/deep", onlyClaude)).toBe(true);
    });
});

describe("background work for a mode chat", () => {
    const keys = { claude: "k", gemini: "k" };

    it("runs on the mode's first serving model", () => {
        expect(concreteModelForChat("varda/auto", keys)).toBe("gemini-3-flash-preview");
        expect(concreteModelForChat("varda/deep", keys)).toBe("claude-sonnet-5");
        expect(concreteModelForChat("claude-opus-5", keys)).toBe("claude-opus-5");
        expect(concreteModelForChat("varda/fast", {})).toBeNull();
    });

    it("titles a mode chat with that model's provider's cheapest model", () => {
        expect(titleModelForChat("varda/auto", null, keys)).toBe("gemini-3.5-flash-lite");
        expect(titleModelForChat("varda/deep", null, keys)).toBe("claude-haiku-4-5");
    });
});

describe("resolveEffectiveChatModel with modes", () => {
    // Gemini serves only Fast, so Deep has nothing a Gemini key can run.
    beforeEach(() =>
        configureTiers({ fast: ["gemini-3-flash-preview"], deep: ["claude-sonnet-5"] }),
    );

    it("keeps the mode itself as the chat's selection", async () => {
        await expect(
            resolveEffectiveChatModel({
                requested: "varda/auto",
                chatModel: "gpt-5.4",
                apiKeys: { gemini: "k" },
                userId: "user-1",
                db,
            }),
        ).resolves.toEqual({ ok: true, model: "varda/auto", source: "request" });
    });

    it("rejects a requested mode no key can serve", async () => {
        await expect(
            resolveEffectiveChatModel({
                requested: "varda/deep",
                apiKeys: { gemini: "k" },
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({ ok: false, status: 422, code: "missing_api_key" });
    });

    it("skips a saved mode no key can serve and falls back to last-selected", async () => {
        await expect(
            resolveEffectiveChatModel({
                chatModel: "varda/deep",
                lastSelectedModel: "varda/fast",
                apiKeys: { gemini: "k" },
                userId: "user-1",
                db,
            }),
        ).resolves.toEqual({ ok: true, model: "varda/fast", source: "last_selected" });
    });
});
