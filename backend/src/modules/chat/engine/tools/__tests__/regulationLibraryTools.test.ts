import { describe, expect, it, vi } from "vitest";
import { failure, ok } from "../../../../../lib/serviceResult";
import {
    isRegulationLibraryToolName,
    REGULATION_LIBRARY_TOOL_NAMES,
    REGULATION_LIBRARY_TOOLS,
    runRegulationLibraryTool,
} from "../regulationLibraryTools";

const SCOPE = { userId: "u1", orgIds: ["o1"], adminOrgIds: [], platformAdmin: false };

function sseFrames(write: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return write.mock.calls.map(([chunk]) => JSON.parse(String(chunk).replace(/^data: /, "")));
}

describe("regulation library tools", () => {
    it("advertises search and read", () => {
        expect(REGULATION_LIBRARY_TOOLS.map((t) => t.function.name).sort()).toEqual(["read_regulation", "search_regulations"]);
        expect(isRegulationLibraryToolName("search_regulations")).toBe(true);
        expect(isRegulationLibraryToolName("pasal_search_legal")).toBe(false);
    });

    it("searches in the caller's scope and reports through connector frames", async () => {
        const write = vi.fn();
        const search = vi.fn(async () => ok({ query: "syarat batal", hits: [], library: { count: 0 } }));
        const read = vi.fn();
        const { content, event } = await runRegulationLibraryTool({
            toolName: REGULATION_LIBRARY_TOOL_NAMES.search,
            args: { query: " syarat batal ", limit: "5", regulation: "" },
            userId: "u1",
            db: {} as never,
            write,
            deps: { resolveScope: vi.fn(async () => SCOPE), search, read },
        });
        expect(search).toHaveBeenCalledWith({}, SCOPE, { query: "syarat batal", regulation: undefined, limit: 5 });
        expect(read).not.toHaveBeenCalled();
        expect(JSON.parse(content)).toEqual({ query: "syarat batal", hits: [], library: { count: 0 } });
        expect(event).toMatchObject({ type: "mcp_tool_call", connector_name: "Regulation Library", tool_name: "search_regulations", status: "ok" });
        expect(sseFrames(write).map((f) => f.type)).toEqual(["mcp_tool_start", "mcp_tool_result"]);
    });

    it("passes read selectors through and surfaces service failures as errors", async () => {
        const write = vi.fn();
        const read = vi.fn(async () => failure("validation", 'Selector "halaman 3" tidak dikenali.'));
        const { content, event } = await runRegulationLibraryTool({
            toolName: REGULATION_LIBRARY_TOOL_NAMES.read,
            args: { regulation: "KUHPerdata", selector: "halaman 3", max_chars: 2000 },
            userId: "u1",
            db: {} as never,
            write,
            deps: { resolveScope: vi.fn(async () => SCOPE), search: vi.fn(), read },
        });
        expect(read).toHaveBeenCalledWith({}, SCOPE, { regulation: "KUHPerdata", selector: "halaman 3", maxChars: 2000 });
        expect(JSON.parse(content)).toEqual({ error: 'Selector "halaman 3" tidak dikenali.' });
        expect(event.status).toBe("error");
        expect(sseFrames(write)[1]).toMatchObject({ status: "error", error: expect.stringContaining("tidak dikenali") });
    });

    it("never throws when the library is unreachable", async () => {
        const write = vi.fn();
        const { content, event } = await runRegulationLibraryTool({
            toolName: REGULATION_LIBRARY_TOOL_NAMES.search,
            args: { query: "x" },
            userId: "u1",
            db: {} as never,
            write,
            deps: { resolveScope: vi.fn(async () => { throw new Error("db down"); }), search: vi.fn(), read: vi.fn() },
        });
        expect(event.status).toBe("error");
        expect(JSON.parse(content).error).toContain("tidak dapat diakses");
    });
});
