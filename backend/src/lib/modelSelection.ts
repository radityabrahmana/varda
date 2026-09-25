import {
    CLAUDE_LOW_MODELS,
    DEFAULT_TIER_MODELS,
    GEMINI_LOW_MODELS,
    isModeModelId,
    modeForModelId,
    OPENAI_LOW_MODELS,
    providerForModel,
    normalizeReasoningLevelForModel,
    resolveModel,
    type UserApiKeys,
    REASONING_LEVELS,
    type AssistantMode,
    type ModelTier,
    type ReasoningLevel,
} from "./llm";
import {
    apiKeyForConfiguredModel,
    configuredModelRequiresApiKey,
    configuredTierModels,
    getConfiguredModel,
} from "./llm/registry";
import {
    isRouterModelSelected,
    type RouterModelSelections,
} from "./routerModels";
import { resolveRequestedModel } from "./routerModels";
import type { Db } from "./supabase";
import { UserFacingError } from "./userFacingError";

export const MODEL_REQUIRED_DETAIL =
    "Select a model before sending a message.";

export const TABULAR_MODEL_REQUIRED_DETAIL =
    "Select a model for this tabular review before running it.";

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "high";

export function normalizeReasoningLevel(
    value: unknown,
): ReasoningLevel | null {
    // `minimal` was previously persisted; treat it as Low while migrations
    // and older clients converge on the current reasoning-level union.
    if (value === "minimal") return "low";
    return typeof value === "string" &&
        (REASONING_LEVELS as readonly string[]).includes(value)
        ? (value as ReasoningLevel)
        : null;
}

/** Resolve request → chat → profile, defaulting a never-selected user to High. */
export function resolveEffectiveReasoningLevel(args: {
    model: string;
    requested?: unknown;
    chatReasoningLevel?: unknown;
    lastSelectedReasoningLevel?: unknown;
}): ReasoningLevel {
    const selected =
        normalizeReasoningLevel(args.requested) ??
        normalizeReasoningLevel(args.chatReasoningLevel) ??
        normalizeReasoningLevel(args.lastSelectedReasoningLevel) ??
        DEFAULT_REASONING_LEVEL;

    return (
        normalizeReasoningLevelForModel(args.model, selected) ??
        DEFAULT_REASONING_LEVEL
    );
}

/**
 * Normalize a stored optional preference without inventing a fallback.
 * Router preferences are valid only while they remain in the user's saved
 * router-model allowlist.
 */
export function normalizeOptionalModelPreference(
    value: string | null | undefined,
    routerModels: RouterModelSelections,
): string | null {
    const resolved = resolveModel(value, "");
    if (!resolved || !isRouterModelSelected(resolved, routerModels)) return null;
    return resolved;
}

/** Whether a resolved model can actually run with the user's current keys. */
export function hasApiKeyForModel(
    model: string,
    apiKeys: UserApiKeys,
): boolean {
    if (isModeModelId(model)) {
        const mode = modeForModelId(model);
        // Auto borrows across tiers, so either one having a model is enough.
        return (
            servingModelsForMode(mode, mode === "deep" ? "deep" : "fast", apiKeys)
                .models.length > 0
        );
    }
    const provider = providerForModel(model);
    if (provider === "ollama") return true;
    if (provider === "openai-compatible") {
        const configured = getConfiguredModel(model);
        return (
            configured !== null &&
            (!configuredModelRequiresApiKey(configured) ||
                apiKeyForConfiguredModel(configured, apiKeys) !== null)
        );
    }
    return !!apiKeys[provider]?.trim();
}

// ---------------------------------------------------------------------------
// Assistant modes
// ---------------------------------------------------------------------------

/** The tier's ordered model list: the deployment's, else the built-in one. */
export function tierModels(tier: ModelTier): readonly string[] {
    return configuredTierModels(tier) ?? DEFAULT_TIER_MODELS[tier];
}

/** The tier's models this user can run right now, in fallback order. */
export function availableTierModels(
    tier: ModelTier,
    apiKeys: UserApiKeys,
): string[] {
    return tierModels(tier).filter((model) => {
        // A tier entry is operator configuration, but a typo or a retired id
        // must cost one skipped entry, not every routed turn.
        if (resolveModel(model, "") !== model || isModeModelId(model)) {
            return false;
        }
        return hasApiKeyForModel(model, apiKeys);
    });
}

/**
 * The models that may serve a turn routed to `tier`, first choice first.
 *
 * Auto may borrow the other tier when this one has nothing the user can run:
 * a slower or lighter answer beats no answer, and the turn's model_info event
 * says which model actually replied. Fast and Deep never borrow, because the
 * person asked for that tier by name.
 */
export function servingModelsForMode(
    mode: AssistantMode,
    tier: ModelTier,
    apiKeys: UserApiKeys,
): { tier: ModelTier; models: string[] } {
    const primary = availableTierModels(tier, apiKeys);
    if (primary.length > 0 || mode !== "auto") return { tier, models: primary };
    const other: ModelTier = tier === "fast" ? "deep" : "fast";
    return { tier: other, models: availableTierModels(other, apiKeys) };
}

/**
 * The concrete model a chat's background work (title, memory curation) uses.
 * Those jobs have no turn to route, so a mode chat uses its first serving
 * model on the fast tier, or on the deep tier for a chat pinned to Deep.
 * Returns the model unchanged when it is already concrete.
 */
export function concreteModelForChat(
    model: string,
    apiKeys: UserApiKeys,
): string | null {
    if (!isModeModelId(model)) return model;
    const mode = modeForModelId(model);
    return (
        servingModelsForMode(mode, mode === "deep" ? "deep" : "fast", apiKeys)
            .models[0] ?? null
    );
}

type EffectiveChatModelResult =
    | {
          ok: true;
          model: string;
          source: "request" | "chat" | "last_selected";
      }
    | {
          ok: false;
          status: 400 | 422;
          code: "model_required" | "model_unavailable" | "missing_api_key";
          detail: string;
      };

/**
 * Resolve a chat turn without inventing a product default. An explicit
 * request is authoritative. Otherwise the chat's saved model wins, with the
 * one profile-level last-selected model as the only fallback.
 */
export async function resolveEffectiveChatModel(args: {
    requested?: string | null;
    chatModel?: string | null;
    lastSelectedModel?: string | null;
    apiKeys: UserApiKeys;
    userId: string;
    db: Db;
}): Promise<EffectiveChatModelResult> {
    const requestedText = args.requested?.trim() ?? "";
    if (requestedText && isModeModelId(requestedText)) {
        if (!hasApiKeyForModel(requestedText, args.apiKeys)) {
            return {
                ok: false,
                status: 422,
                code: "missing_api_key",
                detail: "No Assistant model is available with the current API keys. Add a key or ask an administrator to configure one.",
            };
        }
        return { ok: true, model: requestedText, source: "request" };
    }
    if (requestedText) {
        const requested = resolveModel(requestedText, "");
        if (!requested) {
            return {
                ok: false,
                status: 400,
                code: "model_unavailable",
                detail: `Model "${requestedText}" is not available. Select another model.`,
            };
        }
        try {
            const model = await resolveRequestedModel(
                requested,
                "",
                args.userId,
                args.db,
                "throw",
            );
            if (!hasApiKeyForModel(model, args.apiKeys)) {
                return {
                    ok: false,
                    status: 422,
                    code: "missing_api_key",
                    detail: `An API key is required to use ${model}. Add the key or select another model.`,
                };
            }
            return { ok: true, model, source: "request" };
        } catch (error) {
            if (error instanceof UserFacingError) {
                return {
                    ok: false,
                    status: 400,
                    code: "model_unavailable",
                    detail: error.message,
                };
            }
            throw error;
        }
    }

    const storedCandidates = [
        { value: args.chatModel, source: "chat" as const },
        { value: args.lastSelectedModel, source: "last_selected" as const },
    ];
    for (const candidate of storedCandidates) {
        if (isModeModelId(candidate.value)) {
            if (hasApiKeyForModel(candidate.value, args.apiKeys)) {
                return {
                    ok: true,
                    model: candidate.value,
                    source: candidate.source,
                };
            }
            continue;
        }
        const resolved = resolveModel(candidate.value, "");
        if (!resolved) continue;
        const selected = await resolveRequestedModel(
            resolved,
            "",
            args.userId,
            args.db,
            "fallback",
        );
        if (selected && hasApiKeyForModel(selected, args.apiKeys)) {
            return { ok: true, model: selected, source: candidate.source };
        }
    }

    return {
        ok: false,
        status: 400,
        code: "model_required",
        detail: MODEL_REQUIRED_DETAIL,
    };
}

/**
 * Pick the model used for automatic title generation.
 *
 * A saved title preference is an explicit override. Otherwise first-party
 * chat models map to that provider's cheapest title-tier model. Routers and
 * local models reuse the exact chat model because Varda cannot safely infer a
 * cheaper equivalent within an external/dynamic catalog.
 */
export function titleModelForChat(
    chatModel: string,
    titleOverride?: string | null,
    /** Needed to pick a concrete model for a chat that is in a mode. */
    apiKeys: UserApiKeys = {},
): string {
    const override = resolveModel(titleOverride, "");
    if (override) return override;

    const concreteChatModel = concreteModelForChat(chatModel, apiKeys) ?? "";
    const resolvedChatModel = resolveModel(concreteChatModel, "");
    if (!resolvedChatModel) {
        throw new Error("A supported chat model is required for title generation");
    }

    switch (providerForModel(resolvedChatModel)) {
        case "claude":
            return CLAUDE_LOW_MODELS[0];
        case "gemini":
            return GEMINI_LOW_MODELS[0];
        case "openai":
            return OPENAI_LOW_MODELS[0];
        case "openrouter":
        case "vercel":
        case "opencode-go":
        case "ollama":
        case "openai-compatible":
            return resolvedChatModel;
    }
}
