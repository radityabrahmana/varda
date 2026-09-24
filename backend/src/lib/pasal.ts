// Pasal.id — hosted Indonesian legislation database, reached over its MCP
// server (Streamable HTTP + bearer token). This is the Indonesian counterpart
// of ./courtlistener.ts: an operator-configured research source the Assistant
// can call for every user, unlike the per-user connectors in ./mcp/.
//
// Deliberately thin: the Assistant's tool schemas and prompt live in
// modules/chat/engine/tools/pasalTools.ts; this file only knows how to reach
// the server, cap the payload and turn failures into messages the model can
// act on. It never throws on a failed call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const PASAL_DEFAULT_MCP_URL = "https://mcp.pasal.id/mcp";
/** Pasal.id's read_law defaults to 30k chars; we keep one result well inside the model's context. */
export const PASAL_RESULT_MAX_CHARS = 40_000;
const PASAL_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "varda-pasal-client", version: "1.0.0" };

/** Whether the deployment has a Pasal.id token; gates both the tool schemas and the prompt section. */
export function pasalConfigured(): boolean {
    return Boolean(process.env.PASAL_MCP_TOKEN?.trim());
}

export function pasalMcpUrl(): string {
    return process.env.PASAL_MCP_URL?.trim() || PASAL_DEFAULT_MCP_URL;
}

export type PasalToolResult =
    | { ok: true; text: string; truncated: boolean }
    | { ok: false; error: string; kind: PasalErrorKind };

export type PasalErrorKind =
    | "not_configured"
    | "auth"
    | "rate_limit"
    | "tool_error"
    | "unavailable";

/** The slice of the MCP client the caller needs; tests substitute it. */
export type PasalClient = {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
};

export type PasalDeps = { connect: () => Promise<PasalClient> };

async function defaultConnect(): Promise<PasalClient> {
    const token = process.env.PASAL_MCP_TOKEN?.trim();
    if (!token) throw new PasalNotConfiguredError();
    const transport = new StreamableHTTPClientTransport(new URL(pasalMcpUrl()), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    await client.connect(transport, { timeout: PASAL_TIMEOUT_MS });
    return {
        callTool: (name, args) =>
            client.callTool({ name, arguments: args }, undefined, {
                timeout: PASAL_TIMEOUT_MS,
                maxTotalTimeout: PASAL_TIMEOUT_MS,
            }),
        close: () => client.close(),
    };
}

class PasalNotConfiguredError extends Error {
    constructor() {
        super("PASAL_MCP_TOKEN is not set.");
    }
}

const DEFAULT_DEPS: PasalDeps = { connect: defaultConnect };

/**
 * Call one Pasal.id MCP tool (`resolve_law`, `search_legal`, `get_law_context`,
 * `read_law`, `search_court_decisions`) and return its text payload.
 * Connects per call: the server is stateless for our purposes and a fresh
 * session is cheaper than reasoning about a stale one across turns.
 */
export async function callPasalTool(
    name: string,
    args: Record<string, unknown>,
    deps: PasalDeps = DEFAULT_DEPS,
): Promise<PasalToolResult> {
    let client: PasalClient | null = null;
    try {
        client = await deps.connect();
        const raw = await client.callTool(name, args);
        const text = textContent(raw);
        if (isErrorResult(raw)) {
            return { ok: false, kind: "tool_error", error: text || "Pasal.id reported a tool error." };
        }
        return truncate(text);
    } catch (err) {
        return { ok: false, ...classifyFailure(err) };
    } finally {
        await client?.close().catch(() => undefined);
    }
}

function isErrorResult(raw: unknown): boolean {
    return Boolean(raw && typeof raw === "object" && (raw as { isError?: unknown }).isError === true);
}

/** Pasal.id answers with one `text` content item holding a JSON document; join defensively. */
function textContent(raw: unknown): string {
    if (!raw || typeof raw !== "object") return "";
    const content = (raw as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) =>
            item && typeof item === "object" && (item as { type?: unknown }).type === "text"
                ? String((item as { text?: unknown }).text ?? "")
                : "",
        )
        .filter(Boolean)
        .join("\n")
        .trim();
}

function truncate(text: string): PasalToolResult {
    if (text.length <= PASAL_RESULT_MAX_CHARS) return { ok: true, text, truncated: false };
    return {
        ok: true,
        truncated: true,
        text:
            `${text.slice(0, PASAL_RESULT_MAX_CHARS)}\n\n` +
            `[Pasal.id result truncated to ${PASAL_RESULT_MAX_CHARS} characters. ` +
            "Ask for less: a narrower selector, a smaller limit, or the next_cursor.]",
    };
}

function classifyFailure(err: unknown): { kind: PasalErrorKind; error: string } {
    if (err instanceof PasalNotConfiguredError) {
        return { kind: "not_configured", error: "Pasal.id is not configured on this server (PASAL_MCP_TOKEN)." };
    }
    const message = err instanceof Error && err.message ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    const status = typeof code === "number" ? code : Number(/\b(401|403|429)\b/.exec(message)?.[1] ?? NaN);
    if (status === 401 || status === 403 || /unauthori[sz]ed|authentication failed|token_missing|invalid.token/i.test(message)) {
        return { kind: "auth", error: "Pasal.id rejected the server token. Ask an administrator to check PASAL_MCP_TOKEN." };
    }
    if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
        return { kind: "rate_limit", error: "Pasal.id rate limit reached. Stop calling Pasal.id for this turn." };
    }
    return { kind: "unavailable", error: `Pasal.id is unavailable right now: ${message.slice(0, 200)}` };
}
