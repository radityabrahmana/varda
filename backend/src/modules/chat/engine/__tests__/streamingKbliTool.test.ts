import { beforeEach, describe, expect, it, vi } from "vitest";

// lookup_kbli runs on a bundled dataset. It is offered whenever that file is
// present, independently of any external token, and narrow surfaces can opt
// out; the prompt section follows the same gate.

const { streamChatWithTools, kbliAvailable } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  kbliAvailable: vi.fn(() => true),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../../lib/pasal", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/pasal")),
  pasalConfigured: () => false,
}));
vi.mock("../../../../lib/kbli", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/kbli")),
  kbliAvailable: () => kbliAvailable(),
}));

import { runLLMStream } from "../streaming";
import { buildSystemPrompt } from "../prompts";

type StreamChatCall = {
  tools: { function: { name: string } }[];
  [key: string]: unknown;
};

function baseParams() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
  };
}

function advertisedToolNames(): string[] {
  const params = streamChatWithTools.mock.calls[0]?.[0] as StreamChatCall;
  return params.tools.map((tool) => tool.function.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("lookup_kbli advertisement", () => {
  it("is offered when the dataset is bundled, without any Pasal.id token", async () => {
    kbliAvailable.mockReturnValue(true);
    await runLLMStream(baseParams());
    expect(advertisedToolNames()).toContain("lookup_kbli");
    expect(advertisedToolNames()).not.toContain("pasal_resolve_law");
  });

  it("is hidden when the dataset is missing", async () => {
    kbliAvailable.mockReturnValue(false);
    await runLLMStream(baseParams());
    expect(advertisedToolNames()).not.toContain("lookup_kbli");
  });

  it("lets a narrow surface opt out", async () => {
    kbliAvailable.mockReturnValue(true);
    await runLLMStream({ ...baseParams(), includeKbliTool: false });
    expect(advertisedToolNames()).not.toContain("lookup_kbli");
  });
});

describe("system prompt KBLI section", () => {
  it("follows the tool gate", () => {
    expect(buildSystemPrompt(false, false, true)).toContain("KBLI CODE LOOKUP");
    expect(buildSystemPrompt(false, false, false)).not.toContain("KBLI CODE LOOKUP");
    kbliAvailable.mockReturnValue(true);
    expect(buildSystemPrompt(false, false)).toContain("KBLI CODE LOOKUP");
    kbliAvailable.mockReturnValue(false);
    expect(buildSystemPrompt(false, false)).not.toContain("lookup_kbli");
  });
});
