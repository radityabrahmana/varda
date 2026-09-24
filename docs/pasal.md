# Pasal.id integration (Indonesian legislation)

The Assistant can look up Indonesian laws and regulations on
[Pasal.id](https://pasal.id): resolve a citation to a canonical regulation,
check whether it is in force, amended or revoked, read specific articles, run a
filtered full-text search, and search Constitutional Court (MK) decisions. It is
the Indonesian counterpart of the CourtListener integration and lives in the
same slot of the chat engine.

## Enable

1. Create a free Pasal.id account and a personal token under
   **Akun → Akses API & MCP** (token prefix `pasal_mcp_`).
2. Set `PASAL_MCP_TOKEN` in the backend environment and restart the backend.
   `PASAL_MCP_URL` overrides the server URL (default `https://mcp.pasal.id/mcp`).

With the token present, every web-assistant chat gets the five `pasal_*` tools
and the "INDONESIAN LAW RESEARCH" section of the system prompt. Without it,
neither is shown to the model. The Word add-in and tabular surfaces opt out.
The token is server-wide, so all users share Pasal.id's per-token rate limits.

## Where the code is

| Piece | File |
| --- | --- |
| MCP client, result cap, error classification | `backend/src/lib/pasal.ts` |
| Tool schemas, system prompt, dispatcher glue | `backend/src/modules/chat/engine/tools/pasalTools.ts` |
| Dispatch branch | `backend/src/modules/chat/engine/tools/toolDispatcher.ts` |
| Advertisement gate (`includePasalTools`) | `backend/src/modules/chat/engine/streaming.ts` |
| Prompt splice | `backend/src/modules/chat/engine/prompts.ts` |

Progress and results reach the UI as the existing `mcp_tool_call` events with
connector name "Pasal.id", so the frontend needed no changes.

## Tools

| Tool | Pasal.id tool | Use |
| --- | --- | --- |
| `pasal_resolve_law` | `resolve_law` | Citation or title → `law_id`, title, status |
| `pasal_get_law_context` | `get_law_context` | `summary`, `outline` or `relationships` (amendments, revocations, MK reviews) |
| `pasal_read_law` | `read_law` | Article text by selector (`pasal 20`, `pasal 27-30`, `bab III`, `lampiran`), paged by cursor |
| `pasal_search_legal` | `search_legal` | Full-text search with `regulation_types`, `region`, `issuing_body`, year and status filters |
| `pasal_search_court_decisions` | `search_court_decisions` | Mahkamah Konstitusi decisions |

`read_law` is capped at 30,000 characters per call (default 12,000), and every
result is truncated at 40,000 characters with a hint to narrow the request.

## Known limits (probed 2026-09-24)

- Named national regulations resolve reliably with status. The KUHPerdata
  (civil code) and some ministerial regulations are not in the corpus; a miss
  means "not in Pasal.id", not "no such rule".
- Regional rules (Perda, Pergub) are present but topical search only works
  with the `region` and `regulation_types` filters; the prompt instructs this.
- The KBLI classification annex is one long text readable only by paging. Code
  lookups use the local table described in `docs/kbli.md` instead.
- Results carry Pasal.id's own disclaimer; the prompt asks the model to repeat
  it once when an answer relies on Pasal.id.
