import { beforeEach, describe, expect, it, vi } from "vitest";

// The regulation library tools depend on per-user data: they are offered, and
// described in the system prompt, only when the caller can see at least one
// parsed regulation. Narrow surfaces opt out explicitly.

const { streamChatWithTools, hasVisibleRegulations } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  hasVisibleRegulations: vi.fn(async (_userId: string, _db: unknown) => false),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../regulations/regulations.service", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../regulations/regulations.service")),
  hasVisibleRegulations: (userId: string, db: unknown) => hasVisibleRegulations(userId, db),
}));

import { runLLMStream } from "../streaming";

type StreamChatCall = {
  systemPrompt: string;
  tools: { function: { name: string } }[];
  [key: string]: unknown;
};

function baseParams() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "system", content: "BASE PROMPT" }, { role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
  };
}

function lastCall(): StreamChatCall {
  return streamChatWithTools.mock.calls[0]?.[0] as StreamChatCall;
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("regulation library advertisement", () => {
  it("offers the tools and the prompt section when the caller can see a regulation", async () => {
    hasVisibleRegulations.mockResolvedValue(true);
    await runLLMStream(baseParams());
    const names = lastCall().tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["search_regulations", "read_regulation"]));
    expect(lastCall().systemPrompt).toContain("ORGANIZATION REGULATION LIBRARY");
    expect(lastCall().systemPrompt).toContain("BASE PROMPT");
    expect(hasVisibleRegulations).toHaveBeenCalledWith("u1", expect.anything());
  });

  it("hides both when the caller has no regulation", async () => {
    hasVisibleRegulations.mockResolvedValue(false);
    await runLLMStream(baseParams());
    const names = lastCall().tools.map((t) => t.function.name);
    expect(names).not.toContain("search_regulations");
    expect(lastCall().systemPrompt).not.toContain("ORGANIZATION REGULATION LIBRARY");
  });

  it("lets a narrow surface opt out without consulting the database", async () => {
    hasVisibleRegulations.mockResolvedValue(true);
    await runLLMStream({ ...baseParams(), includeRegulationLibrary: false });
    expect(lastCall().tools.map((t) => t.function.name)).not.toContain("read_regulation");
    expect(hasVisibleRegulations).not.toHaveBeenCalled();
  });
});
