-- Google Drive as a document source (docs/google-drive.md).
--
-- One Google connection per user (the refresh token that lets Varda export
-- their Google Docs), the short-lived OAuth state handed to Google, and the
-- link from an imported Varda document back to the Drive file it came from
-- (so a later "save back to Google Drive" knows where to write).
--
-- Apply by hand in the Varda Supabase SQL editor, like the other Dash-side
-- files in this directory. Idempotent.

create table if not exists public.user_google_drive_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_account_email text,
  scope text not null,
  encrypted_access_token text not null,
  access_token_iv text not null,
  access_token_tag text not null,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  access_token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.google_drive_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_google_drive_oauth_states_expires
  on public.google_drive_oauth_states(expires_at);

create table if not exists public.document_google_drive_links (
  document_id uuid primary key references public.documents(id) on delete cascade,
  drive_file_id text not null,
  drive_mime_type text not null,
  drive_name text not null,
  drive_modified_time timestamptz,
  drive_head_revision_id text,
  drive_web_view_link text,
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_document_google_drive_links_file
  on public.document_google_drive_links(drive_file_id);

-- Backend service role only: tokens never reach a browser client.
alter table public.user_google_drive_connections enable row level security;
alter table public.google_drive_oauth_states enable row level security;
alter table public.document_google_drive_links enable row level security;

revoke all on public.user_google_drive_connections from anon, authenticated;
revoke all on public.google_drive_oauth_states from anon, authenticated;
revoke all on public.document_google_drive_links from anon, authenticated;
