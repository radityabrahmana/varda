import { beforeEach, describe, expect, it, vi } from "vitest";

// Pasal.id (Indonesian legislation) tools are gated on the server-side
// PASAL_MCP_TOKEN. A deployment without it must not show the model the
// schemas, and must not describe the tools in the system prompt either.

const { streamChatWithTools, pasalConfigured } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  pasalConfigured: vi.fn(() => false),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../../lib/pasal", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/pasal")),
  pasalConfigured: () => pasalConfigured(),
}));

import { runLLMStream } from "../streaming";
import { buildSystemPrompt } from "../prompts";
import { PASAL_TOOL_NAMES } from "../tools/pasalTools";

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

const PASAL_NAMES = Object.values(PASAL_TOOL_NAMES);

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("pasal_* tool advertisement", () => {
  it("offers every Pasal.id tool when the server token is configured", async () => {
    pasalConfigured.mockReturnValue(true);
    await runLLMStream(baseParams());
    expect(advertisedToolNames()).toEqual(expect.arrayContaining(PASAL_NAMES));
  });

  it("hides them when the token is missing", async () => {
    pasalConfigured.mockReturnValue(false);
    await runLLMStream(baseParams());
    for (const name of PASAL_NAMES) expect(advertisedToolNames()).not.toContain(name);
  });

  it("lets a narrow surface opt out even when configured", async () => {
    pasalConfigured.mockReturnValue(true);
    await runLLMStream({ ...baseParams(), includePasalTools: false });
    for (const name of PASAL_NAMES) expect(advertisedToolNames()).not.toContain(name);
  });

  it("does not depend on the US case-law toggle", async () => {
    pasalConfigured.mockReturnValue(true);
    await runLLMStream({ ...baseParams(), includeResearchTools: false });
    expect(advertisedToolNames()).toEqual(expect.arrayContaining(PASAL_NAMES));
    expect(advertisedToolNames()).not.toContain("courtlistener_verify_citations");
  });
});

describe("system prompt research sections", () => {
  it("describes Pasal.id only when its tools are present", () => {
    expect(buildSystemPrompt(true, true)).toContain("INDONESIAN LAW RESEARCH");
    expect(buildSystemPrompt(false, true)).toContain("INDONESIAN LAW RESEARCH");
    expect(buildSystemPrompt(false, true)).not.toContain("US CASE LAW RESEARCH");
    expect(buildSystemPrompt(true, false)).not.toContain("INDONESIAN LAW RESEARCH");
    expect(buildSystemPrompt(false, false)).not.toContain("pasal_");
  });

  it("defaults the Pasal.id section to the server configuration", () => {
    pasalConfigured.mockReturnValue(true);
    expect(buildSystemPrompt(false)).toContain("INDONESIAN LAW RESEARCH");
    pasalConfigured.mockReturnValue(false);
    expect(buildSystemPrompt(false)).not.toContain("INDONESIAN LAW RESEARCH");
  });
});
