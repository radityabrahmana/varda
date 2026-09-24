import { describe, expect, it, vi } from "vitest";
import { KBLI_TOOL_NAME, KBLI_TOOLS, runKbliTool } from "../kbliTool";

function sseFrames(write: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return write.mock.calls.map(([chunk]) => JSON.parse(String(chunk).replace(/^data: /, "")));
}

describe("lookup_kbli tool", () => {
    it("advertises one tool that takes a code and/or a query", () => {
        expect(KBLI_TOOLS).toHaveLength(1);
        const fn = KBLI_TOOLS[0].function;
        expect(fn.name).toBe(KBLI_TOOL_NAME);
        const props = (fn.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(props).sort()).toEqual(["code", "limit", "query"]);
    });

    it("emits connector-style frames and returns the lookup as JSON", () => {
        const write = vi.fn();
        const lookup = vi.fn(() => ({
            source: { regulation: "r", edition: "e", url: "u" },
            guidance: ["g"],
        }));
        const { content, event } = runKbliTool({ args: { code: " 49231 ", limit: "5" }, write, lookup });
        expect(lookup).toHaveBeenCalledWith({ code: " 49231 ", query: undefined, limit: 5 });
        expect(JSON.parse(content)).toMatchObject({ guidance: ["g"] });
        expect(event).toEqual({
            type: "mcp_tool_call",
            connector_id: "kbli",
            connector_name: "KBLI 2025",
            tool_name: "lookup_kbli",
            openai_tool_name: "lookup_kbli",
            status: "ok",
        });
        expect(sseFrames(write)).toEqual([
            { type: "mcp_tool_start", name: "lookup_kbli" },
            { type: "mcp_tool_result", name: "lookup_kbli", connector_name: "KBLI 2025", tool_name: "lookup_kbli", status: "ok" },
        ]);
    });

    it("surfaces lookup errors as an error event", () => {
        const write = vi.fn();
        const { content, event } = runKbliTool({ args: {}, write });
        expect(JSON.parse(content)).toEqual({ error: "Provide a KBLI code, a query, or both." });
        expect(event.status).toBe("error");
        expect(event.error).toContain("Provide a KBLI code");
        expect(sseFrames(write)[1]).toMatchObject({ status: "error" });
    });

    it("answers from the bundled dataset end to end", () => {
        const { content, event } = runKbliTool({ args: { query: "angkutan barang dengan kendaraan bermotor" }, write: vi.fn() });
        expect(event.status).toBe("ok");
        const parsed = JSON.parse(content) as { query: { matches: { code: string }[] } };
        expect(parsed.query.matches.map((m) => m.code)).toContain("49231");
    });
});
