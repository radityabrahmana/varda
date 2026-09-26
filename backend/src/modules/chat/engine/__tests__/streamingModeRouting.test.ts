import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatParams, StreamChatResult } from "../../../../lib/llm/types";

const { streamChatWithTools } = vi.hoisted(() => ({
    streamChatWithTools: vi.fn<
        (params: StreamChatParams) => Promise<StreamChatResult>
    >(async () => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
    streamChatWithTools: (params: StreamChatParams) =>
        streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
    buildUserMcpTools: vi.fn(async () => []),
}));

import { resetModelRegistryCache } from "../../../../lib/llm/registry";
import { toProviderStreamError } from "../../../../lib/llm/providerErrors";
import { buildMessages } from "../contextBuilders";
import { parseUserTurn } from "../routing";
import { AssistantStreamError, runLLMStream } from "../streaming";

const API_KEYS = { gemini: "g", openai: "o", claude: "c" };

function overloaded(): Error {
    return toProviderStreamError(
        Object.assign(new Error("overloaded"), { statusCode: 529 }),
        { label: "Provider", modelId: "m" },
    );
}

async function run(model: string, userContent = "Apa arti force majeure?") {
    const write = vi.fn();
    const result = await runLLMStream({
        apiMessages: [{ role: "user", content: userContent }],
        docStore: new Map(),
        docIndex: {},
        userId: "user-1",
        db: {} as never,
        write,
        model,
        apiKeys: API_KEYS,
        includeRegulationLibrary: false,
    });
    return { result, write };
}

function modelInfoEvents(events: { type: string }[]) {
    return events.filter((event) => event.type === "model_info");
}

beforeEach(() => {
    vi.clearAllMocks();
    streamChatWithTools.mockResolvedValue({ fullText: "" });
    process.env.VARDA_MODEL_CONFIG_JSON = JSON.stringify({
        tiers: {
            fast: ["gemini-3-flash-preview", "gpt-5.6-terra"],
            deep: ["claude-sonnet-5"],
        },
    });
    resetModelRegistryCache();
});

afterEach(() => {
    delete process.env.VARDA_MODEL_CONFIG_JSON;
    resetModelRegistryCache();
});

describe("runLLMStream Assistant modes", () => {
    it("serves a short Auto question from the fast tier at low effort", async () => {
        const { result } = await run("varda/auto");

        expect(streamChatWithTools).toHaveBeenCalledTimes(1);
        expect(streamChatWithTools.mock.calls[0][0]).toMatchObject({
            model: "gemini-3-flash-preview",
            reasoning: "low",
        });
        expect(modelInfoEvents(result.events)).toEqual([
            {
                type: "model_info",
                model: "gemini-3-flash-preview",
                mode: "auto",
                tier: "fast",
                reason: "default",
            },
        ]);
    });

    it("sends a review request to the deep tier at high effort", async () => {
        const { result } = await run("varda/auto", "Tolong tinjau klausul ganti rugi");

        expect(streamChatWithTools.mock.calls[0][0]).toMatchObject({
            model: "claude-sonnet-5",
            reasoning: "high",
        });
        expect(modelInfoEvents(result.events)).toEqual([
            expect.objectContaining({ tier: "deep", reason: "deep_intent" }),
        ]);
    });

    it("falls back within the tier when the first model fails before any output", async () => {
        streamChatWithTools.mockRejectedValueOnce(overloaded());

        const { result, write } = await run("varda/fast");

        expect(streamChatWithTools.mock.calls.map((call) => call[0].model)).toEqual([
            "gemini-3-flash-preview",
            "gpt-5.6-terra",
        ]);
        // One persisted record of who answered, not one per attempt.
        expect(modelInfoEvents(result.events)).toEqual([
            {
                type: "model_info",
                model: "gpt-5.6-terra",
                mode: "fast",
                tier: "fast",
                reason: "mode_fast",
                fallback_from: "gemini-3-flash-preview",
            },
        ]);
        const streamedInfo = write.mock.calls
            .map((call) => String(call[0]))
            .filter((chunk) => chunk.includes('"model_info"'));
        expect(streamedInfo).toHaveLength(2);
    });

    it("does not fall back once the first model has streamed output", async () => {
        streamChatWithTools.mockImplementationOnce(async (params) => {
            params.callbacks?.onContentDelta?.("Force majeure adalah");
            throw overloaded();
        });

        await expect(run("varda/fast")).rejects.toBeInstanceOf(AssistantStreamError);
        expect(streamChatWithTools).toHaveBeenCalledTimes(1);
    });

    it("does not fall back from a model the person named", async () => {
        streamChatWithTools.mockRejectedValueOnce(overloaded());

        await expect(run("gemini-3-flash-preview")).rejects.toBeInstanceOf(
            AssistantStreamError,
        );
        expect(streamChatWithTools).toHaveBeenCalledTimes(1);
    });

    it("reports a mode no key can serve instead of guessing a model", async () => {
        process.env.VARDA_MODEL_CONFIG_JSON = JSON.stringify({
            tiers: { deep: ["claude-opus-5"] },
        });
        resetModelRegistryCache();
        const failure = runLLMStream({
            apiMessages: [{ role: "user", content: "hello" }],
            docStore: new Map(),
            docIndex: {},
            userId: "user-1",
            db: {} as never,
            write: vi.fn(),
            model: "varda/deep",
            apiKeys: { gemini: "g" },
            includeRegulationLibrary: false,
        });

        await expect(failure).rejects.toThrow(/No model is available for Deep mode/);
        expect(streamChatWithTools).not.toHaveBeenCalled();
    });
});

describe("routing signals", () => {
    it("reads the markers buildMessages writes", () => {
        const [, user] = buildMessages(
            [
                {
                    role: "user",
                    content: "Bandingkan kedua draf ini",
                    workflow: { id: "wf-1", title: "Review Kontrak" },
                    files: [
                        { filename: "a.docx", document_id: "d1" },
                        { filename: "b.docx", document_id: "d2" },
                    ],
                },
            ] as never,
            [],
            undefined,
            { "doc-0": { document_id: "d1", filename: "a.docx" } },
            false,
            "nonce1234",
        ) as { content: string }[];

        expect(parseUserTurn(user.content)).toEqual({
            text: "Bandingkan kedua draf ini",
            workflow: true,
            documents: [expect.stringContaining("doc-0"), expect.any(String)],
        });
    });

    it("treats text without markers as the person's own words", () => {
        expect(parseUserTurn("[Workflow: not closed")).toEqual({
            text: "[Workflow: not closed",
            workflow: false,
            documents: [],
        });
    });
});
