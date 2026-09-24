# Varda at Dash Electric — operations notes

Varda is this fork of Mike (`open-legal-products/mike`) run as PT Dash Elektrik
Indonesia's contract-review platform. It replaced the Lovable app "Janus/Tinjau"
in September 2026. This file is the one place a new session needs to read
before touching deployment, data or the Dash-specific modules.

## Where things run

| Piece | Location |
| --- | --- |
| Frontend | Railway service `mike-frontend`, https://varda.dashelectric.co (custom domain, CNAME → `2bd1t698.up.railway.app`) |
| Backend | Railway service `janusid-dd78a9ba` (Express, LibreOffice in the image), reached through the frontend's `/api` proxy |
| Railway project | `beautiful-solace`, environment `production` (account: dashelectric.co) |
| Database + auth + storage | Supabase project `tmnlpfpzoxmujwilhbpw` (Varda's own; bucket `mike`, S3 protocol, region ap-southeast-1) |
| Models | OpenRouter via `OPENROUTER_API_KEY`; Assistant models come from `MIKE_MODEL_CONFIG_JSON` (Gemini 3 Flash / 2.5 Pro over OpenRouter); contract review uses `google/gemini-2.5-pro` → `gemini-2.5-flash` fallback (`CONTRACTS_AI_MODEL`, `CONTRACTS_AI_FALLBACK_MODEL`, `CONTRACTS_AI_MAX_TOKENS`) |
| Legal research | Pasal.id (Indonesian legislation) via `PASAL_MCP_TOKEN` on the backend service; see `docs/pasal.md`. CourtListener (US) is not configured. |
| Sign-up | `SIGNUP_ALLOWED_DOMAINS=dashelectric.co` + `auth.users` trigger; Google login enabled in Supabase |
| Organization | "Dash Electric" (`55d6b8f4-…`); every `@dashelectric.co` account joins via an `auth.users` trigger |

## Deploying

Always from this clone (`~/varda`), on `main`, after the PR is merged:

```bash
git checkout main && git pull
railway up --ci -s janusid-dd78a9ba     # backend
railway up --ci -s mike-frontend        # frontend
```

`railway variable set|delete -s <service> ...` for env changes (CLI ≥ 4.30 syntax).
`railway logs -s <service> --lines N` and `railway deployment list -s <service>` are the
read-only checks. A `next/font/google` "queries have exactly one entry" build failure is a
transient Turbopack issue: retry the deploy.

Open PRs against **this fork** — `gh pr create -R radityabrahmana/varda --base main --head <branch>`
(the clone's `gh` default is set to the fork; the upstream remote would otherwise win).

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
- `frontend/src/app/components/contracts/`, `components/playbook/`, pages `/contracts`, `/contracts/new`,
  `/contracts/[id]`, `/playbook`.
- `backend/janus-migrations/*.sql` — SQL for the **Dash-only tables** (reviews, playbook_rules,
  review_feedback, …). These are NOT run by the upstream migration runner: paste them into the
  Varda Supabase SQL editor by hand. Upstream `backend/migrations/` stays untouched.

## Workflows in the Dash Electric org

- **Review Kontrak Client** — PKS/LOI review via `review_contract`.
- **Review NDA** — asks counterparty type and Dash's role, reviews as `document_type = NDA`.

## History and open items

Full session-by-session log (decisions, incidents, verification evidence):
`~/.gstack/projects/radityabrahmana-janusid-dd78a9ba/HANDOFF-mike-migration.md` (local file on
Raditya's Mac). Cutover runbook: `~/Desktop/varda-cutover-runbook-2026-09-22.md`.

Known follow-ups as of 2026-09-23: "new clause" revisions cannot be projected as tracked changes (insertion support needed);
Janus Lovable project still hosts the redirect and must be kept ~2 weeks, then frozen;
remove `ALLOWED_ORIGINS` from the backend once the old Railway URL is unused.
