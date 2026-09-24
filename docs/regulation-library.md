# Regulation library

Each organization can keep its own library of regulations: the codes and rules
its work depends on, including ones public sources lack. Varda parses each
upload into articles (Pasal) and gives the Assistant two tools over it,
`search_regulations` and `read_regulation`, so answers cite the organization's
own text. A logistics tenant loads the civil code and transport-ministry rules;
an energy tenant loads ESDM regulations. Varda administrators can also publish
platform-wide regulations that every organization sees.

## Scopes and roles

| Scope | Visible to | Managed by |
| --- | --- | --- |
| Platform-wide (`org_id` null) | every signed-in user | Varda admins (`user_roles.role = 'admin'`) |
| Organization | the organization's members | its admins, and Varda admins |

A regulation the caller may not see answers 404, so ids never confirm another
tenant's holdings.

## Data

Tables from `backend/janus-migrations/20260924_01_regulation_library.sql`
(apply by hand in the Supabase SQL editor, like the other Dash-side tables):

- `regulations`: metadata (type, issuer, number, year, title, `short_name`
  people cite it by, status berlaku / diubah / dicabut / tidak_berlaku /
  unknown, source URL, notes), the stored original (`file_key`), and parse
  results (`parse_status`, counts, warnings).
- `regulation_nodes`: one row per structural heading (buku, bab, bagian,
  paragraf), article (pasal, with the full article text), elucidation entry
  (penjelasan), preamble, or fallback text chunk (content). `context` is the
  heading chain above a node. `fts` is a generated `tsvector` using the
  `indonesian` configuration; `search_regulation_nodes(...)` is the ranked
  search function (websearch syntax, plain-word fallback).

## Ingestion

1. `POST /regulations` with metadata creates the row (`parse_status: empty`).
2. `PUT /regulations/:id/file` with the raw file body (`?filename=` or
   `x-filename`; PDF, DOCX or TXT, up to 50 MB) extracts the text, parses it,
   replaces the nodes and stores the original at `regulations/<id>/source.<ext>`.
3. `POST /regulations/:id/reparse` re-runs extraction and parsing on the stored
   original, for use after parser improvements.

The parser is `backend/src/lib/regulationParse.ts`. It recognises BUKU / BAB /
Bagian / Paragraf headings with titles on the same or following lines, `Pasal N`
headings (own line, or with text after a colon or period), the PENJELASAN part
with its general section and per-article entries, and LAMPIRAN as text chunks.
A `Pasal N` line is treated as a heading only when it continues the article
sequence, which keeps wrapped cross-references inside their article. Documents
with no article structure are stored as searchable text chunks. Parse warnings
are kept on the row; review them after uploading.

For bulk or platform-wide loading from a terminal, with the service-role key:

```bash
npx tsx scripts/ingest-regulation.ts --file kuhperdata.pdf \
  --title "Kitab Undang-Undang Hukum Perdata" --short-name KUHPerdata \
  --type KUHPERDATA --year 1847 --platform
```

## Assistant tools

The tools and the "ORGANIZATION REGULATION LIBRARY" prompt section are offered
only when the caller can see at least one parsed regulation, decided per turn
in `streaming.ts`; the Word add-in and tabular surfaces opt out.

- `search_regulations {query, regulation?, limit?}`: ranked snippets with a
  citation ("Pasal 1266 KUHPerdata"), the regulation's status, and the library
  catalog so the model knows what is held.
- `read_regulation {regulation, selector, max_chars?}`: `pasal 1266`,
  `pasal 1266-1267`, `pasal 5, 7-9`, `bab III`, `penjelasan pasal 5`,
  `menimbang`, `outline`. Results carry the heading chain and are capped
  (default 12,000 characters, maximum 40,000).

The prompt tells the model to search the library first for any Indonesian-law
question, to read before quoting, to report the status the organization set,
and to treat a miss as "not held here" before moving on to Pasal.id.

## HTTP surface

`GET /regulations`, `POST /regulations`, `GET /regulations/:id` (with outline),
`PATCH /regulations/:id`, `DELETE /regulations/:id`, `PUT /regulations/:id/file`,
`POST /regulations/:id/reparse`, `GET /regulations/:id/read?selector=…`,
`GET /regulations/search?q=…&regulation=…`, `GET /regulations/:id/file`.

## Code

| Piece | File |
| --- | --- |
| Access model | `backend/src/modules/regulations/regulations.access.ts` |
| CRUD and ingestion | `backend/src/modules/regulations/regulations.library.ts` |
| Search, selectors, reading | `backend/src/modules/regulations/regulations.read.ts` |
| Routes | `backend/src/modules/regulations/regulations.routes.ts` |
| Parser | `backend/src/lib/regulationParse.ts` |
| Assistant tools and prompt | `backend/src/modules/chat/engine/tools/regulationLibraryTools.ts` |

## Limits

- Scanned PDFs without a text layer cannot be ingested; the upload is refused
  with a message saying so.
- Status is set by the organization, not verified against a source. Pair the
  library with the Pasal.id tools when currency matters.
- The management UI is a separate change; until it lands, use the HTTP routes
  or the ingest script.
