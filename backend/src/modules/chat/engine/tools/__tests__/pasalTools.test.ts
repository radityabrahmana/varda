import { describe, expect, it, vi } from "vitest";
import type { PasalToolResult } from "../../../../../lib/pasal";
import {
    isPasalToolName,
    normalizePasalArgs,
    PASAL_READ_DEFAULT_CHARS,
    PASAL_READ_MAX_CHARS,
    PASAL_TOOL_NAMES,
    PASAL_TOOLS,
    pasalMcpToolName,
    runPasalTool,
} from "../pasalTools";

function sseFrames(write: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return write.mock.calls.map(([chunk]) => JSON.parse(String(chunk).replace(/^data: /, "")));
}

describe("pasal tool naming", () => {
    it("advertises exactly the pasal_* tools and maps them onto the MCP names", () => {
        const advertised = PASAL_TOOLS.map((tool) => tool.function.name);
        expect(advertised.sort()).toEqual(Object.values(PASAL_TOOL_NAMES).sort());
        for (const name of advertised) {
            expect(isPasalToolName(name)).toBe(true);
            expect(name.startsWith("pasal_")).toBe(true);
        }
        expect(pasalMcpToolName("pasal_read_law")).toBe("read_law");
        expect(isPasalToolName("mcp_pasal_read_law")).toBe(false);
        expect(isPasalToolName("read_document")).toBe(false);
    });
});

describe("normalizePasalArgs", () => {
    it("drops empty values and coerces numeric law ids", () => {
        expect(
            normalizePasalArgs(PASAL_TOOL_NAMES.getLawContext, {
                law: " 16 ",
                detail: "",
                region: null,
                regulation_types: [],
            }),
        ).toEqual({ law: 16 });
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.searchLegal, { query: "upah", law_id: "60884" })).toEqual({
            query: "upah",
            law_id: 60884,
        });
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.resolveLaw, { reference: "UU 27 tahun 2022" })).toEqual({
            reference: "UU 27 tahun 2022",
        });
    });

    it("clamps search limits to Pasal.id's 1-20 window", () => {
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.searchLegal, { query: "q", limit: 50 }).limit).toBe(20);
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.searchLegal, { query: "q", limit: 0 }).limit).toBe(1);
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.searchLegal, { query: "q", limit: "abc" })).toEqual({ query: "q" });
    });

    it("gives read_law a bounded character budget", () => {
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.readLaw, { law: 16, selector: "pasal 20" }).max_chars).toBe(
            PASAL_READ_DEFAULT_CHARS,
        );
        expect(
            normalizePasalArgs(PASAL_TOOL_NAMES.readLaw, { law: 16, selector: "all", max_chars: 999_999 }).max_chars,
        ).toBe(PASAL_READ_MAX_CHARS);
        expect(normalizePasalArgs(PASAL_TOOL_NAMES.readLaw, { law: 16, selector: "all", max_chars: 10 }).max_chars).toBe(
            1000,
        );
    });
});

describe("runPasalTool", () => {
    it("emits connector-style progress frames and hands the model the payload", async () => {
        const write = vi.fn();
        const call = vi.fn(async (): Promise<PasalToolResult> => ({ ok: true, text: '{"resolved":true}', truncated: false }));
        const { content, event } = await runPasalTool({
            toolName: PASAL_TOOL_NAMES.resolveLaw,
            args: { reference: "UU PDP", region: "" },
            write,
            call,
        });
        expect(call).toHaveBeenCalledWith("resolve_law", { reference: "UU PDP" });
        expect(content).toContain('{"resolved":true}');
        expect(content).toContain("not instructions");
        expect(event).toEqual({
            type: "mcp_tool_call",
            connector_id: "pasal",
            connector_name: "Pasal.id",
            tool_name: "resolve_law",
            openai_tool_name: "pasal_resolve_law",
            status: "ok",
        });
        expect(sseFrames(write)).toEqual([
            { type: "mcp_tool_start", name: "pasal_resolve_law" },
            {
                type: "mcp_tool_result",
                name: "pasal_resolve_law",
                connector_name: "Pasal.id",
                tool_name: "resolve_law",
                status: "ok",
            },
        ]);
    });

    it("reports failures as error events and a JSON error the model can read", async () => {
        const write = vi.fn();
        const call = vi.fn(async (): Promise<PasalToolResult> => ({
            ok: false,
            kind: "rate_limit",
            error: "Pasal.id rate limit reached. Stop calling Pasal.id for this turn.",
        }));
        const { content, event } = await runPasalTool({
            toolName: PASAL_TOOL_NAMES.searchLegal,
            args: { query: "upah minimum" },
            write,
            call,
        });
        expect(event.status).toBe("error");
        expect(event.error).toContain("rate limit");
        expect(JSON.parse(content)).toEqual({
            error: "Pasal.id rate limit reached. Stop calling Pasal.id for this turn.",
            kind: "rate_limit",
        });
        const frames = sseFrames(write);
        expect(frames[1]).toMatchObject({ type: "mcp_tool_result", status: "error" });
        expect(frames[1].error).toContain("rate limit");
    });
});
