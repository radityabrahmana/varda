-- Suggestion mode: people (not the AI) propose edits directly in the contract DOCX.
--
-- Each row is one tracked change (w:del + w:ins, either may be absent for a pure
-- insertion or deletion) written into the working redline
-- (reviews.contract_redline_path) under the author's name, like Word's
-- "Suggesting" mode. Accept keeps the new text, Reject restores the original;
-- both rewrite the working DOCX. Written by
-- backend/src/modules/contracts/contracts.suggestions.ts.
--
-- Idempotent. Run in the Supabase SQL editor of the Varda project after
-- 20260923_02_review_access_grants.sql.

create table if not exists public.review_suggestions (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  author_email text,
  author_name text not null,
  original_text text not null default '',
  suggested_text text not null default '',
  note text,
  change_id text,
  del_w_id text,
  ins_w_id text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_suggestions_review_idx on public.review_suggestions(review_id, created_at);

-- Backend-only (service role), like the other contract tables.
alter table public.review_suggestions enable row level security;
revoke all on public.review_suggestions from anon, authenticated;
grant select, insert, update, delete on public.review_suggestions to service_role;

notify pgrst, 'reload schema';

select to_regclass('public.review_suggestions') as suggestions_table;
