# Varda at Dash Electric — operations notes

Varda is run as PT Dash Elektrik
Indonesia's contract-review platform. It replaced the Lovable app "Janus/Tinjau"
in September 2026. This file is the one place a new session needs to read
before touching deployment, data or the Dash-specific modules.

## Where things run

| Piece | Location |
| --- | --- |
| Frontend | Railway service `varda-frontend`, https://varda.dashelectric.co (custom domain, CNAME → `2bd1t698.up.railway.app`) |
| Backend | Railway service `janusid-dd78a9ba` (Express, LibreOffice in the image), reached through the frontend's `/api` proxy |
| Railway project | `beautiful-solace`, environment `production` (account: dashelectric.co) |
| Database + auth + storage | Supabase project `tmnlpfpzoxmujwilhbpw` (Varda's own; bucket `varda`, S3 protocol, region ap-southeast-1) |
| Models | OpenRouter via `OPENROUTER_API_KEY`; Assistant models come from `VARDA_MODEL_CONFIG_JSON` (Gemini 3 Flash / 2.5 Pro over OpenRouter), plus a `tiers` block for the Auto/Fast/Deep modes (Fast = `openrouter/google/gemini-3.8-flash`, Deep = `openrouter/anthropic/claude-sonnet-5`; `docs/assistant-modes.md`); contract review uses `google/gemini-2.5-pro` → `gemini-2.5-flash` fallback (`CONTRACTS_AI_MODEL`, `CONTRACTS_AI_FALLBACK_MODEL`, `CONTRACTS_AI_MAX_TOKENS`) |
| Legal research | Pasal.id (Indonesian legislation) via `PASAL_MCP_TOKEN` on the backend service; see `docs/pasal.md`. CourtListener (US) is not configured. |
| Google Drive | Sources → Google Drive in the composer imports Google Docs as DOCX (`docs/google-drive.md`). Needs `GOOGLE_DRIVE_OAUTH_CLIENT_ID/SECRET` on the backend service (a Web OAuth client in Google Cloud with redirect URI `https://varda.dashelectric.co/api/google-drive/oauth/callback`, Drive API enabled, consent screen Internal) and the SQL in `janus-migrations/20260926_01_google_drive.sql`. |
| Sign-up | `SIGNUP_ALLOWED_DOMAINS=dashelectric.co` + `auth.users` trigger; Google login enabled in Supabase |
| Organization | "Dash Electric" (`55d6b8f4-…`); every `@dashelectric.co` account joins via an `auth.users` trigger |

## Deploying

Always from this clone (`~/varda`), on `main`, after the PR is merged:

```bash
git checkout main && git pull
railway up --ci -s janusid-dd78a9ba     # backend
railway up --ci -s varda-frontend       # frontend
```

`railway variable set|delete -s <service> ...` for env changes (CLI ≥ 4.30 syntax).
`railway logs -s <service> --lines N` and `railway deployment list -s <service>` are the
read-only checks. A `next/font/google` "queries have exactly one entry" build failure is a
transient Turbopack issue: retry the deploy.

Open PRs against `radityabrahmana/varda` — `gh pr create -R radityabrahmana/varda --base main --head <branch>`.

## Dash-specific code

- `backend/src/modules/contracts/` — reviews, AI prompts (`contracts.ai.ts`), redline projection,
  DOCX persistence, feedback, memo. Facade `contracts.service.ts`.
- Contract reviews are **private**: visible to the uploader, people they share with (Bagikan →
  `review_access_grants`, owner/editor/viewer), and Varda admins (`user_roles.role = 'admin'`).
  Enforced per route in `contracts.access.ts`; contract tables have no `anon`/`authenticated`
  table privileges (backend service role only).
- **Suggestion mode** (`contracts.suggestions.ts`, `review_suggestions`): select text in the DOCX
  → "Sarankan perubahan" writes a tracked change under the person's name into the working
  redline (`contracts/<id>/redline.docx`); Terima/Tolak on the Saran tab resolves it. One
  paragraph per suggestion. All writes to the working DOCX go through `withReviewDocLock`.
- `backend/src/modules/playbook/` — playbook rules, scoped per document type (`applies_to`).
- `backend/src/modules/chat/engine/tools/contractReviewTool.ts` — the Assistant's `review_contract` tool.
- `backend/src/lib/pasal.ts` + `backend/src/modules/chat/engine/tools/pasalTools.ts` — the Assistant's
  `pasal_*` tools for grounded Indonesian-law lookups (status, articles, Perda/Pergub, MK). Gated on
  `PASAL_MCP_TOKEN`. Not used by the contract review pipeline yet.
- `backend/src/lib/kbli.ts` + `tools/kbliTool.ts` + `backend/data/kbli/kbli-2025.json` — the Assistant's
  `lookup_kbli` tool over the bundled KBLI 2025 table (see `docs/kbli.md`). No env needed.
- `backend/src/modules/regulations/` — the per-organization regulation library (`docs/regulation-library.md`):
  upload KUHPerdata, Permenhub and other rules Pasal.id lacks; the Assistant gets `search_regulations` /
  `read_regulation`. Generic by design: another tenant loads its own ministry's rules. Tables in
  `janus-migrations/20260924_01_regulation_library.sql` (apply by hand).
- `backend/src/modules/google-drive/` — Google Drive as a document source (`docs/google-drive.md`): per-user
  OAuth connection, file listing, import as version 1 with `source = 'google_drive'` plus a
  `document_google_drive_links` row for the later write-back. Generic by design. Tables in
  `janus-migrations/20260926_01_google_drive.sql` (apply by hand).
- `frontend/src/app/components/contracts/`, `components/playbook/`, pages `/contracts`, `/contracts/new`,
  `/contracts/[id]`, `/playbook`.
- `backend/janus-migrations/*.sql` — SQL for the **Dash-only tables** (reviews, playbook_rules,
  review_feedback, …). These are NOT run by the `backend/migrations/` runner: paste them into the
  Varda Supabase SQL editor by hand. Existing `backend/migrations/` files stay untouched.

## Workflows in the Dash Electric org

- **Review Kontrak Client** — PKS/LOI review via `review_contract`.
- **Review NDA** — asks counterparty type and Dash's role, reviews as `document_type = NDA`.

## History and open items

Full session-by-session log (decisions, incidents, verification evidence):
`~/.gstack/projects/radityabrahmana-janusid-dd78a9ba/HANDOFF-mike-migration.md` (local file on
Raditya's Mac). Cutover runbook: `~/Desktop/varda-cutover-runbook-2026-09-22.md`.

Known follow-ups as of 2026-09-23: "new clause" revisions cannot be projected as tracked changes (insertion support needed);
Janus Lovable project still hosts the redirect and must be kept ~2 weeks, then frozen.
