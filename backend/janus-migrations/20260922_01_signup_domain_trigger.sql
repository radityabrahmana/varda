-- Hard enforcement of the sign-up domain policy (mirrors SIGNUP_ALLOWED_DOMAINS
-- on the backend). Runs in the Varda (Mike) Supabase SQL editor — NOT Lovable.
-- Blocks every new auth.users row whose email is not @dashelectric.co, whether it
-- comes from the password form, Google OAuth, or a direct GoTrue call with the
-- publishable key. Existing accounts are untouched (insert-only trigger).

create or replace function public.enforce_signup_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed text[] := array['dashelectric.co'];
begin
  if new.email is null
     or not (lower(split_part(new.email, '@', 2)) = any (allowed)) then
    raise exception 'Sign-up is limited to approved company email addresses.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_signup_domain on auth.users;
create trigger enforce_signup_domain
  before insert on auth.users
  for each row execute function public.enforce_signup_domain();

-- Verify:
--   select tgname, tgenabled from pg_trigger where tgname = 'enforce_signup_domain';
-- Roll back:
--   drop trigger if exists enforce_signup_domain on auth.users;
--   drop function if exists public.enforce_signup_domain();
