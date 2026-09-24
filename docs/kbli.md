# KBLI lookup (Indonesian business classification)

The Assistant has a local table of the KBLI (Klasifikasi Baku Lapangan Usaha
Indonesia) and a `lookup_kbli` tool over it: exact definition of a code with
its parent chain, children and sibling codes, or ranked candidate codes for an
activity described in Indonesian. It exists because Pasal.id holds the KBLI
annex as one long text that can only be paged, not searched.

## Data

`backend/data/kbli/kbli-2025.json` (about 1.5 MB) is generated from the annex
of **Peraturan BPS No. 6 Tahun 2026**, which restates the whole classification
of Peraturan BPS No. 7 Tahun 2025 (KBLI 2025) with the 2026 changes applied.
It holds 2,443 entries: 21 kategori, 87 golongan pokok, 258 golongan, 519
subgolongan and 1,558 five-digit kelompok. Each entry has `code`, `level`,
`title`, `description` and `parent`; the file also records its `source`
(regulation, edition, Pasal.id law id and URL, fetch date). Every "lihat
kelompok" cross-reference in the text resolves to an entry, and kelompok codes
are in ascending order, which the build script's counts and warnings check.

KBLI 2025 renumbered codes. Goods road transport, for example, is 49231 where
KBLI 2020 used 49431, and courier is 53200. The tool tells the model when a
code does not exist and how to find the current one.

The annex text comes from a PDF extraction, so descriptions occasionally carry
split words ("laha n"). Two entries lost the opening words of their
description at the source (49221, 60103), and the title of 60103 is cut short.
Titles are otherwise clean.

### Regenerating

From `backend/`, with `PASAL_MCP_TOKEN` set:

```bash
npx tsx scripts/build-kbli-dataset.ts
```

This pages the annex through Pasal.id (about 70 calls, backing off on its rate
limit) and writes the JSON. To re-parse a saved annex text instead, pass
`--from-text <file>`. The parser is `backend/src/lib/kbliParse.ts`; its tests
pin the text shapes it handles. Review the printed counts and warnings before
committing a regenerated file.

## Code

| Piece | File |
| --- | --- |
| Dataset loading, code lookup, query search | `backend/src/lib/kbli.ts` |
| Annex parser | `backend/src/lib/kbliParse.ts` |
| Tool schema, prompt section, runner | `backend/src/modules/chat/engine/tools/kbliTool.ts` |
| Dispatch, advertisement gate (`includeKbliTool`), prompt splice | `toolDispatcher.ts`, `streaming.ts`, `prompts.ts` |

The tool is offered whenever the dataset file is present. The Word add-in and
tabular surfaces opt out. Progress shows in the UI as "KBLI 2025: lookup_kbli"
through the existing connector events.

## Limits

- Classification only. Risk level and permits per code come from PP 28/2025
  and the OSS system; the prompt sends the model to the Pasal.id tools for the
  legal text and tells it the per-code risk annex is not available.
- Search is token based with prefix matching and a small Indonesian stopword
  list. It is meant to surface candidates for the model to read, not to decide.
