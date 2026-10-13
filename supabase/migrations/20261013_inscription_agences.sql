-- ============================================================================
-- Phase 2 — inscription des agences en libre-service (2026-10-13)
-- ============================================================================

-- 1. Informations d'abonnement de l'agence (utilisées par l'étape Stripe)
alter table public.organizations
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists subscription_status text not null default 'trialing',
  add column if not exists trial_ends_at timestamptz default (now() + interval '30 days'),
  add column if not exists stripe_customer_id text;

alter table public.organizations drop constraint if exists organizations_subscription_status_check;
alter table public.organizations add constraint organizations_subscription_status_check
  check (subscription_status in ('trialing', 'active', 'past_due', 'canceled'));

-- Les agences existantes (pilote) restent actives, sans période d'essai
update public.organizations set subscription_status = 'active', trial_ends_at = null
where created_by is null and subscription_status = 'trialing';

-- 2. La Direction peut renommer son agence, mais jamais toucher à l'abonnement
revoke update on public.organizations from authenticated, anon;
grant update (name) on public.organizations to authenticated;

-- 3. Création d'une agence par un utilisateur connecté, à l'email confirmé, sans agence
create or replace function public.create_organization(p_org_name text, p_full_name text)
 returns public.profiles
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user auth.users%rowtype;
  v_org uuid;
  v_profile profiles%rowtype;
  v_name text := trim(coalesce(p_org_name, ''));
begin
  select * into v_user from auth.users where id = auth.uid();
  if not found then
    raise exception 'Connexion requise.' using errcode = '28000';
  end if;
  if v_user.email_confirmed_at is null then
    raise exception 'Confirme d''abord ton adresse email.' using errcode = '28000';
  end if;
  if exists (select 1 from profiles where id = v_user.id) then
    raise exception 'Ce compte appartient déjà à une agence.' using errcode = '23505';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Le nom de l''agence doit faire entre 2 et 120 caractères.' using errcode = '22023';
  end if;

  insert into organizations (name, created_by, subscription_status, trial_ends_at)
  values (v_name, v_user.id, 'trialing', now() + interval '30 days')
  returning id into v_org;

  insert into profiles (id, organization_id, full_name, role, email)
  values (
    v_user.id, v_org,
    coalesce(nullif(trim(p_full_name), ''), split_part(v_user.email, '@', 1)),
    'direction', v_user.email
  )
  returning * into v_profile;

  return v_profile;
end;
$function$;

revoke execute on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated;
