-- Regulation library: curated regulations an organization uploads (PDF/DOCX/TXT),
-- parsed into articles (Pasal) so the Assistant's search_regulations /
-- read_regulation tools can cite them. Fills the gaps in Pasal.id's corpus
-- (KUHPerdata, ministry rules) and lets every tenant hold the rules its own
-- sector needs. org_id NULL = platform-wide, visible to every organization
-- (managed by Varda admins, user_roles.role = 'admin'); otherwise visible to
-- the organization's members and managed by its admins.
--
-- Backend-only tables (service role); browsers never read them directly.

create table if not exists public.regulations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  regulation_type text not null,
  issuer text,
  number text,
  year int,
  title text not null,
  short_name text not null,
  status text not null default 'berlaku'
    check (status in ('berlaku', 'diubah', 'dicabut', 'tidak_berlaku', 'unknown')),
  source_url text,
  notes text,
  file_key text,
  file_name text,
  content_sha256 text,
  parse_status text not null default 'empty' check (parse_status in ('empty', 'parsed', 'failed')),
  node_count int not null default 0,
  pasal_count int not null default 0,
  parse_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists regulations_org_idx on public.regulations(org_id);
create index if not exists regulations_short_name_idx on public.regulations(lower(short_name));

alter table public.regulations enable row level security;
revoke all on public.regulations from anon, authenticated;

-- One row per structural heading (buku/bab/bagian/paragraf), article (pasal),
-- elucidation entry (penjelasan), preamble, or fallback text chunk (content).
-- `context` is the denormalized heading chain above a node ("BUKU KETIGA ›
-- BAB IV › Bagian Kedua"), which is what a citation needs. Only the text-bearing
-- node types are searched; see search_regulation_nodes below.
create table if not exists public.regulation_nodes (
  id bigserial primary key,
  regulation_id uuid not null references public.regulations(id) on delete cascade,
  node_type text not null
    check (node_type in ('buku', 'bab', 'bagian', 'paragraf', 'pasal', 'penjelasan', 'preamble', 'content')),
  number text,
  heading text,
  context text,
  content text not null default '',
  sort_order int not null,
  -- PostgreSQL ships an 'indonesian' snowball configuration (PG 13+). If a
  -- database lacks it, replace with 'simple' here and in the function below.
  fts tsvector generated always as (
    to_tsvector('indonesian', coalesce(heading, '') || ' ' || content)
  ) stored
);

create index if not exists regulation_nodes_reg_order_idx on public.regulation_nodes(regulation_id, sort_order);
create index if not exists regulation_nodes_reg_type_number_idx on public.regulation_nodes(regulation_id, node_type, number);
create index if not exists regulation_nodes_fts_idx on public.regulation_nodes using gin(fts);

alter table public.regulation_nodes enable row level security;
revoke all on public.regulation_nodes from anon, authenticated;

-- Ranked full-text search across the regulations visible to a caller
-- (platform-wide rows plus the caller's organizations), optionally within one
-- regulation. websearch syntax first ("angkutan barang" -berbahaya), plain
-- words as the fallback so a query never errors.
create or replace function public.search_regulation_nodes(
  p_org_ids uuid[],
  p_query text,
  p_regulation_id uuid default null,
  p_limit int default 10
)
returns table (
  node_id bigint,
  regulation_id uuid,
  node_type text,
  number text,
  heading text,
  context text,
  snippet text,
  rank real,
  short_name text,
  title text,
  status text,
  regulation_type text,
  issuer text
)
language sql
stable
set search_path = public
as $$
  with q as (
    -- numnode() = 0 is the "no lexemes" case; comparing with ''::tsquery
    -- would log a NOTICE on every call.
    select case
      when numnode(websearch_to_tsquery('indonesian', p_query)) > 0
        then websearch_to_tsquery('indonesian', p_query)
      else plainto_tsquery('indonesian', p_query)
    end as tsq
  )
  select
    n.id,
    n.regulation_id,
    n.node_type,
    n.number,
    n.heading,
    n.context,
    ts_headline('indonesian', n.content, q.tsq,
      'MaxWords=60, MinWords=25, MaxFragments=2, FragmentDelimiter=" … "') as snippet,
    ts_rank_cd(n.fts, q.tsq) as rank,
    r.short_name,
    r.title,
    r.status,
    r.regulation_type,
    r.issuer
  from public.regulation_nodes n
  join public.regulations r on r.id = n.regulation_id
  cross join q
  where (r.org_id is null or r.org_id = any(coalesce(p_org_ids, '{}'::uuid[])))
    and (p_regulation_id is null or r.id = p_regulation_id)
    and n.node_type in ('pasal', 'penjelasan', 'preamble', 'content')
    and numnode(q.tsq) > 0
    and n.fts @@ q.tsq
  order by rank desc, n.regulation_id, n.sort_order
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.search_regulation_nodes(uuid[], text, uuid, int) from anon, authenticated;
