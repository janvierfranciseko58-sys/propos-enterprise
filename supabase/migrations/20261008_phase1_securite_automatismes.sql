-- ============================================================================
-- Phase 1 — sécurisation des automatismes (2026-10-08)
--  * Les tâches planifiées et le trigger « nouveau bail » n'utilisent plus de clé
--    d'administration écrite en clair : un secret aléatoire est rangé dans Vault et
--    envoyé dans l'en-tête x-cron-secret, vérifié par les Edge Functions.
--  * Relances de loyer limitées (compteur + date du dernier rappel).
-- ============================================================================

-- 1. Secret partagé, généré aléatoirement, stocké chiffré dans Vault
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'propos_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'propos_cron_secret',
      'Secret partagé pg_cron / triggers -> Edge Functions PropOS'
    );
  end if;
end $$;

-- 2. Vérification du secret par les Edge Functions (rôle service uniquement)
create or replace function public.verify_cron_secret(p_secret text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'propos_cron_secret' and decrypted_secret = p_secret
  );
$$;
revoke execute on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

-- 3. Appel d'une Edge Function avec le secret lu dans Vault au moment de l'appel
create or replace function public.call_propos_function(p_function text, p_body jsonb default '{}'::jsonb)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'propos_cron_secret';
  return net.http_post(
    url := 'https://vdpvejwdexclcuwfiout.supabase.co/functions/v1/' || p_function,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := p_body,
    timeout_milliseconds := 10000
  );
end;
$$;
revoke execute on function public.call_propos_function(text, jsonb) from public, anon, authenticated;

-- 4. Tâches planifiées : plus aucune clé dans la commande
do $$
declare j text;
begin
  foreach j in array array['propos-daily-notifications', 'propos-daily-payslips', 'monthly-financial-report'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('propos-daily-notifications', '0 8 * * *', $$select public.call_propos_function('send-notifications')$$);
select cron.schedule('propos-daily-payslips', '0 9 * * *', $$select public.call_propos_function('send-payslips')$$);
select cron.schedule('monthly-financial-report', '0 8 1 * *', $$select public.call_propos_function('monthly-financial-report')$$);

-- 5. Accueil du locataire à la création d'un bail (remplace le webhook à clé en clair)
drop trigger if exists "onboard-tenant-on-lease-created" on public.leases;
create or replace function public.trg_onboard_tenant()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform public.call_propos_function(
    'onboard-tenant',
    jsonb_build_object('type', 'INSERT', 'table', 'leases', 'record', to_jsonb(new))
  );
  return new;
exception when others then
  -- La création du bail ne doit jamais échouer à cause de l'email d'accueil
  raise warning 'onboard-tenant non déclenché : %', sqlerrm;
  return new;
end;
$$;
revoke execute on function public.trg_onboard_tenant() from public, anon, authenticated;
drop trigger if exists onboard_tenant_on_lease_created on public.leases;
create trigger onboard_tenant_on_lease_created
  after insert on public.leases
  for each row execute function public.trg_onboard_tenant();

-- 6. Relances de loyer limitées
alter table public.payments
  add column if not exists reminder_count integer not null default 0,
  add column if not exists last_reminder_at timestamptz;

-- 7. Index manquant signalé par l'outil d'analyse Supabase
create index if not exists idx_staff_invites_invited_by on public.staff_invites (invited_by);
