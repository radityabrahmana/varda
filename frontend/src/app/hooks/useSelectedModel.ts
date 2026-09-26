"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    canonicalModelId,
    ROUTER_SLUGS,
    type RouterSlug,
    type ReasoningLevel,
} from "../components/assistant/ModelToggle";
import { isModelAvailable } from "../lib/modelAvailability";
import { isModeModelId } from "../lib/assistantModes";
import type { ApiKeyState } from "../lib/vardaApi";

/**
 * The composer's accepted-id surface. Exported so the Word add-in drift guard
 * (frontend/src/wordAddin/catalogParity.test.ts) can compare it against the
 * add-in's hand-mirrored copy instead of restating the rule.
 */
export function isAllowedModelId(
    id: string,
    configuredModelIds: readonly string[] = [],
): boolean {
    return (
        ALLOWED_MODEL_IDS.has(id) ||
        isModeModelId(id) ||
        configuredModelIds.includes(id) ||
        id.startsWith("ollama/") ||
        ROUTER_SLUGS.some((slug) => id.startsWith(`${slug}/`))
    );
}

export interface SelectedModelSources {
    selectionKey?: string | null;
    chatModel?: string | null;
    lastSelectedModel?: string | null;
    routerSelections?: {
        openRouterModels: string[];
        vercelModels: string[];
        openCodeGoModels: string[];
    } | null;
    /** Undefined means availability is unknown and must fail open. */
    apiKeys?: ApiKeyState;
    /** Authenticated deployment models returned by GET /models/configured. */
    configuredModelIds?: readonly string[];
    /**
     * False when the person may use Assistant modes only: a saved named model
     * is then set aside for the default. Undefined leaves named models usable.
     */
    advancedModels?: boolean;
    /** Chosen when nothing saved is usable. Empty (the default) means "none". */
    defaultModel?: string;
}

function usableStoredModel(
    value: string | null | undefined,
    sources: SelectedModelSources,
): string | null {
    if (!value) return null;
    const canonical = canonicalModelId(value);
    if (!isAllowedModelId(canonical, sources.configuredModelIds)) return null;
    // Availability of a mode is the server's call (see modelAvailability).
    if (isModeModelId(canonical)) return canonical;
    if (sources.advancedModels === false) return null;

    if (sources.configuredModelIds?.includes(canonical)) return canonical;

    const router = ROUTER_SLUGS.find((slug) =>
        canonical.startsWith(`${slug}/`),
    );
    if (router && sources.routerSelections) {
        const selections: Record<RouterSlug, string[]> = {
            openrouter: sources.routerSelections.openRouterModels,
            vercel: sources.routerSelections.vercelModels,
            "opencode-go": sources.routerSelections.openCodeGoModels,
        };
        if (!selections[router].includes(canonical.slice(router.length + 1))) {
            return null;
        }
    }
    if (sources.apiKeys && !isModelAvailable(canonical, sources.apiKeys)) {
        return null;
    }
    return canonical;
}

/**
 * Resolve chat model → profile last-selected model → `defaultModel`. Without
 * a `defaultModel` there is no product default and the result can be "".
 */
export function useSelectedModel(
    sources: SelectedModelSources = {},
): [string, (id: string) => void] {
    const [model, setModelState] = useState("");
    const manuallySelected = useRef(false);
    const previousSelectionKey = useRef(sources.selectionKey);
    const openRouterModels = sources.routerSelections?.openRouterModels;
    const vercelModels = sources.routerSelections?.vercelModels;
    const openCodeGoModels = sources.routerSelections?.openCodeGoModels;
    const configuredModelIds = sources.configuredModelIds;
    const advancedModels = sources.advancedModels;
    const defaultModel = sources.defaultModel ?? "";
    const hasRouterSelections = sources.routerSelections != null;
    const selectionSources = useMemo<SelectedModelSources>(
        () => ({
            selectionKey: sources.selectionKey,
            chatModel: sources.chatModel,
            lastSelectedModel: sources.lastSelectedModel,
            routerSelections: hasRouterSelections
                ? {
                      openRouterModels: openRouterModels ?? [],
                      vercelModels: vercelModels ?? [],
                      openCodeGoModels: openCodeGoModels ?? [],
                  }
                : null,
            apiKeys: sources.apiKeys,
            configuredModelIds,
            advancedModels,
            defaultModel,
        }),
        [
            sources.selectionKey,
            sources.chatModel,
            sources.lastSelectedModel,
            hasRouterSelections,
            openRouterModels,
            vercelModels,
            openCodeGoModels,
            sources.apiKeys,
            configuredModelIds,
            advancedModels,
            defaultModel,
        ],
    );

    /* eslint-disable react-hooks/set-state-in-effect -- persisted profile/chat settings arrive asynchronously and initialize controlled composer state */
    useEffect(() => {
        if (previousSelectionKey.current !== selectionSources.selectionKey) {
            previousSelectionKey.current = selectionSources.selectionKey;
            manuallySelected.current = false;
        }
        if (manuallySelected.current) return;
        if (
            selectionSources.selectionKey &&
            selectionSources.chatModel === undefined
        ) {
            // Existing chat settings have not loaded yet. Do not flash the
            // profile fallback before the chat's own selection arrives.
            setModelState("");
            return;
        }
        const next =
            usableStoredModel(selectionSources.chatModel, selectionSources) ??
            usableStoredModel(
                selectionSources.lastSelectedModel,
                selectionSources,
            ) ??
            selectionSources.defaultModel ??
            "";
        setModelState(next);
    }, [selectionSources]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const setModel = useCallback(
        (id: string) => {
            const canonical = canonicalModelId(id);
            const next = isAllowedModelId(canonical, configuredModelIds)
                ? canonical
                : "";
            manuallySelected.current = true;
            setModelState(next);
        },
        [configuredModelIds],
    );

    return [model, setModel];
}

export function useSelectedReasoning(sources: {
    selectionKey?: string | null;
    chatReasoningLevel?: ReasoningLevel | null;
    lastSelectedReasoningLevel?: ReasoningLevel | null;
}): [ReasoningLevel, (level: ReasoningLevel) => void] {
    const [level, setLevelState] = useState<ReasoningLevel>("high");
    const manuallySelected = useRef(false);
    const previousSelectionKey = useRef(sources.selectionKey);

    /* eslint-disable react-hooks/set-state-in-effect -- persisted profile/chat settings arrive asynchronously and initialize controlled composer state */
    useEffect(() => {
        if (previousSelectionKey.current !== sources.selectionKey) {
            previousSelectionKey.current = sources.selectionKey;
            manuallySelected.current = false;
        }
        if (manuallySelected.current) return;
        if (sources.selectionKey && sources.chatReasoningLevel === undefined) {
            return;
        }
        setLevelState(
            sources.chatReasoningLevel ??
                sources.lastSelectedReasoningLevel ??
                "high",
        );
    }, [
        sources.selectionKey,
        sources.chatReasoningLevel,
        sources.lastSelectedReasoningLevel,
    ]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const setLevel = useCallback((next: ReasoningLevel) => {
        manuallySelected.current = true;
        setLevelState(next);
    }, []);

    return [level, setLevel];
}
