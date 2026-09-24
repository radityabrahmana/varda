// lookup_kbli: the Assistant's local KBLI (Indonesian business classification)
// table. Bundled data, no network; see lib/kbli.ts. Progress reaches the UI
// through the same mcp_tool_call events as connectors, labelled "KBLI 2025".

import type { OpenAIToolSchema } from "../../../../lib/llm";
import type { McpToolEvent } from "../../../../lib/mcpConnectors";
import { KBLI_DEFAULT_LIMIT, KBLI_MAX_LIMIT, lookupKbli } from "../../../../lib/kbli";

export const KBLI_TOOL_NAME = "lookup_kbli";
export const KBLI_CONNECTOR_NAME = "KBLI 2025";

export const KBLI_SYSTEM_PROMPT = `KBLI CODE LOOKUP:
For any question about a KBLI code (Klasifikasi Baku Lapangan Usaha Indonesia), which code fits a business activity, or what a code covers, call lookup_kbli before answering. The data is the consolidated KBLI 2025 annex (Peraturan BPS No. 7 Tahun 2025 as amended by No. 6 Tahun 2026), bundled locally.
- By code ("49231", "4923", "H"): exact definition, parent chain, children and sibling codes.
- By query in Indonesian ("angkutan barang dengan truk", "kurir", "pergudangan"): ranked candidate codes. Try two phrasings if the first misses.
- Read "mencakup" and "tidak mencakup" before recommending a code, and follow any "lihat kelompok NNNNN" pointer with a code lookup.
- KBLI 2025 renumbered codes; a code from KBLI 2020 (e.g. 49431) may no longer exist. Say so and find the current code by query. Never quote a code or its wording from memory.
- lookup_kbli is the classification only. Risk level and permits per code come from PP 28/2025 and the OSS system; if the Pasal.id tools are available use them for that legal text, and say that the per-code risk annex is not available in the tools.
- Cite the source once as "Lampiran Peraturan BPS No. 6 Tahun 2026 (KBLI 2025)" with the URL returned by the tool.`;

export const KBLI_TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: KBLI_TOOL_NAME,
            description:
                "Look up the Indonesian business classification (KBLI 2025). Pass a code to get its definition, parent chain, children and siblings, or an Indonesian query to get ranked candidate codes with their descriptions. Local data, fast; call it before answering any KBLI question.",
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "A KBLI code: kategori letter (A-U), 2-digit golongan pokok, 3-digit golongan, 4-digit subgolongan or 5-digit kelompok, e.g. '49231'.",
                    },
                    query: {
                        type: "string",
                        description: "Activity described in Indonesian, e.g. 'angkutan barang dengan kendaraan bermotor', 'jasa kurir', 'pergudangan'.",
                    },
                    limit: {
                        type: "integer",
                        description: `Maximum query matches, 1-${KBLI_MAX_LIMIT}. Default ${KBLI_DEFAULT_LIMIT}.`,
                    },
                },
            },
        },
    },
];

export function runKbliTool(params: {
    args: Record<string, unknown>;
    write: (s: string) => void;
    lookup?: typeof lookupKbli;
}): { content: string; event: McpToolEvent } {
    const { args, write, lookup = lookupKbli } = params;
    write(`data: ${JSON.stringify({ type: "mcp_tool_start", name: KBLI_TOOL_NAME })}\n\n`);

    const code = typeof args.code === "string" ? args.code : undefined;
    const query = typeof args.query === "string" ? args.query : undefined;
    const limit = typeof args.limit === "number" ? args.limit : Number(args.limit) || undefined;
    const result = lookup({ code, query, limit });
    const error = "error" in result ? result.error : undefined;

    const event: McpToolEvent = {
        type: "mcp_tool_call",
        connector_id: "kbli",
        connector_name: KBLI_CONNECTOR_NAME,
        tool_name: KBLI_TOOL_NAME,
        openai_tool_name: KBLI_TOOL_NAME,
        status: error ? "error" : "ok",
        ...(error ? { error } : {}),
    };
    write(
        `data: ${JSON.stringify({
            type: "mcp_tool_result",
            name: KBLI_TOOL_NAME,
            connector_name: event.connector_name,
            tool_name: event.tool_name,
            status: event.status,
            error: event.error,
        })}\n\n`,
    );
    return { content: JSON.stringify(result), event };
}
