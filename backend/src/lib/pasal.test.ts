import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    callPasalTool,
    PASAL_DEFAULT_MCP_URL,
    PASAL_RESULT_MAX_CHARS,
    pasalConfigured,
    pasalMcpUrl,
    type PasalClient,
} from "./pasal";

function fakeClient(
    callTool: PasalClient["callTool"],
): { client: PasalClient; close: ReturnType<typeof vi.fn> } {
    const close = vi.fn(async () => undefined);
    return { client: { callTool, close }, close };
}

function textResult(text: string, isError = false) {
    return { content: [{ type: "text", text }], isError };
}

beforeEach(() => {
    vi.stubEnv("PASAL_MCP_TOKEN", "pasal_mcp_test");
    vi.stubEnv("PASAL_MCP_URL", "");
});
afterEach(() => {
    vi.unstubAllEnvs();
});

describe("pasal configuration", () => {
    it("is configured only when a non-blank token is present", () => {
        expect(pasalConfigured()).toBe(true);
        vi.stubEnv("PASAL_MCP_TOKEN", "   ");
        expect(pasalConfigured()).toBe(false);
        vi.stubEnv("PASAL_MCP_TOKEN", "");
        expect(pasalConfigured()).toBe(false);
    });

    it("targets the hosted server unless overridden", () => {
        expect(pasalMcpUrl()).toBe(PASAL_DEFAULT_MCP_URL);
        vi.stubEnv("PASAL_MCP_URL", "https://staging.example/mcp");
        expect(pasalMcpUrl()).toBe("https://staging.example/mcp");
    });

    it("does not connect anywhere when the token is missing", async () => {
        vi.stubEnv("PASAL_MCP_TOKEN", "");
        const result = await callPasalTool("ping", {});
        expect(result).toMatchObject({ ok: false, kind: "not_configured" });
    });
});

describe("callPasalTool", () => {
    it("returns the joined text content and closes the client", async () => {
        const callTool = vi.fn(async () => ({
            content: [
                { type: "text", text: '{"resolved":true}' },
                { type: "image", data: "ignored" },
                { type: "text", text: "tail" },
            ],
        }));
        const { client, close } = fakeClient(callTool);
        const result = await callPasalTool("resolve_law", { reference: "UU 27 Tahun 2022" }, { connect: async () => client });
        expect(result).toEqual({ ok: true, text: '{"resolved":true}\ntail', truncated: false });
        expect(callTool).toHaveBeenCalledWith("resolve_law", { reference: "UU 27 Tahun 2022" });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("surfaces a server-side tool error as tool_error", async () => {
        const { client } = fakeClient(async () => textResult("Unknown regulation type: KEPGUB", true));
        const result = await callPasalTool("search_legal", { query: "upah" }, { connect: async () => client });
        expect(result).toEqual({ ok: false, kind: "tool_error", error: "Unknown regulation type: KEPGUB" });
    });

    it("caps oversized payloads and says how to ask for less", async () => {
        const { client } = fakeClient(async () => textResult("x".repeat(PASAL_RESULT_MAX_CHARS + 500)));
        const result = await callPasalTool("read_law", { law: 16, selector: "all" }, { connect: async () => client });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.truncated).toBe(true);
        expect(result.text.length).toBeLessThan(PASAL_RESULT_MAX_CHARS + 300);
        expect(result.text).toContain("next_cursor");
    });

    it("maps authentication failures to an actionable message", async () => {
        const result = await callPasalTool("ping", {}, {
            connect: async () => {
                throw Object.assign(new Error("HTTP 401: Authentication failed"), { code: 401 });
            },
        });
        expect(result).toMatchObject({ ok: false, kind: "auth" });
        if (result.ok) return;
        expect(result.error).toContain("PASAL_MCP_TOKEN");
    });

    it("maps throttling to rate_limit so the model stops for the turn", async () => {
        const { client, close } = fakeClient(async () => {
            throw new Error("429 Too Many Requests");
        });
        const result = await callPasalTool("search_legal", { query: "x" }, { connect: async () => client });
        expect(result).toMatchObject({ ok: false, kind: "rate_limit" });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("never throws on transport failures", async () => {
        const result = await callPasalTool("ping", {}, {
            connect: async () => {
                throw new Error("fetch failed: ECONNRESET");
            },
        });
        expect(result).toMatchObject({ ok: false, kind: "unavailable" });
        if (result.ok) return;
        expect(result.error).toContain("ECONNRESET");
    });
});
