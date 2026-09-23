-- Private contract reviews: owner + admins + people the owner shares with.
--
-- 1. review_access_grants: one row per (review, recipient email) with a role on
--    the same ladder as assistant chats (owner / editor / viewer). The uploader
--    (reviews.user_id) is the implicit owner and never gets a row. Enforced by
--    backend/src/modules/contracts/contracts.access.ts.
--
-- 2. Contract tables become backend-only. The Janus schema shipped team-wide
--    RLS policies for `authenticated`, so a signed-in user holding their own
--    access token could read every review straight from PostgREST and bypass
--    the backend's privacy checks. Varda's frontend never queries these tables
--    directly (everything goes through /api/contracts on the service role), so
--    table privileges are revoked from anon/authenticated. Reversible with
--    `grant select, insert, update, delete on public.<table> to authenticated;`.
--
-- Idempotent. Run in the Supabase SQL editor of the Varda project.

create table if not exists public.review_access_grants (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  email text not null,
  role text not null default 'viewer' check (role in ('owner', 'editor', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, email),
  constraint review_access_grants_email_lowercase check (email = lower(email))
);

create index if not exists review_access_grants_email_idx on public.review_access_grants(email);
create index if not exists review_access_grants_review_idx on public.review_access_grants(review_id);
create index if not exists reviews_user_id_idx on public.reviews(user_id);

alter table public.review_access_grants enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'reviews',
    'review_feedback',
    'manual_comments',
    'missed_clause_feedback',
    'negotiation_points',
    'review_revision_edits',
    'review_access_grants'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Verification: expect review_access_grants to exist, and no anon/authenticated
-- privileges left on the contract tables (the second query returns 0 rows).
select to_regclass('public.review_access_grants') as grants_table;
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('reviews', 'review_feedback', 'manual_comments', 'missed_clause_feedback',
                     'negotiation_points', 'review_revision_edits', 'review_access_grants');
