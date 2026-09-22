-- Dash Electric organization: auto-membership by email domain.
-- Run in the Varda (Mike) Supabase SQL editor — NOT Lovable.
-- Org "Dash Electric" was created via the API on 2026-09-22:
--   id 55d6b8f4-639e-4112-a6f3-718a81353fa4 (created_by = radityabrahmana@gmail.com admin).
-- 1) Backfill: every existing @dashelectric.co account becomes a member;
--    aditya@dashelectric.co becomes an admin.
-- 2) Trigger: every future @dashelectric.co sign-up is added as a member.
--    Fires AFTER the existing on_auth_user_created trigger (profile row), and
--    never blocks the sign-up itself.

insert into public.org_members (org_id, user_id, role)
select '55d6b8f4-639e-4112-a6f3-718a81353fa4', u.id,
       case when lower(u.email) = 'aditya@dashelectric.co' then 'admin' else 'member' end
from auth.users u
where lower(split_part(u.email, '@', 2)) = 'dashelectric.co'
on conflict (org_id, user_id) do update set role = excluded.role;

create or replace function public.auto_join_dash_electric_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid := '55d6b8f4-639e-4112-a6f3-718a81353fa4';
begin
  if new.email is not null
     and lower(split_part(new.email, '@', 2)) = 'dashelectric.co' then
    begin
      insert into public.org_members (org_id, user_id, role)
      values (target_org, new.id, 'member')
      on conflict (org_id, user_id) do nothing;
    exception when others then
      -- Membership must never break account creation.
      raise warning 'auto_join_dash_electric_org failed for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_join_dash_electric_org on auth.users;
create trigger auto_join_dash_electric_org
  after insert on auth.users
  for each row execute function public.auto_join_dash_electric_org();

-- Verify:
--   select m.role, u.email from public.org_members m join auth.users u on u.id = m.user_id
--   where m.org_id = '55d6b8f4-639e-4112-a6f3-718a81353fa4';
-- Roll back:
--   drop trigger if exists auto_join_dash_electric_org on auth.users;
--   drop function if exists public.auto_join_dash_electric_org();
