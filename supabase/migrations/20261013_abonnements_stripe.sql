-- ============================================================================
-- Phase 2.4 — abonnements Stripe (2026-10-13)
-- ============================================================================

alter table public.organizations
  add column if not exists stripe_subscription_id text,
  add column if not exists billed_quantity integer,
  add column if not exists current_period_end timestamptz;

create unique index if not exists organizations_stripe_customer_id_key
  on public.organizations (stripe_customer_id) where stripe_customer_id is not null;

-- Synchronisation quotidienne du nombre de lots facturés (après les notifications de 8h)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'propos-billing-sync') then
    perform cron.unschedule('propos-billing-sync');
  end if;
end $$;
select cron.schedule('propos-billing-sync', '30 3 * * *', $$select public.call_propos_function('billing-sync')$$);
