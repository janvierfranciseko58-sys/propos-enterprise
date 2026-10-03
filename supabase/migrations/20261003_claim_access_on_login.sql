-- ============================================================================
-- Rattachement à la connexion (2026-10-03)
-- Les triggers ne rattachent un compte qu'au moment de la confirmation de
-- l'email. Ces fonctions couvrent les cas où l'invitation (ou la fiche
-- locataire) arrive APRÈS : membre retiré puis réinvité, locataire ajouté par
-- l'agence après avoir créé son compte. Elles n'agissent que pour l'utilisateur
-- connecté, et seulement si son email est confirmé.
-- ============================================================================

create or replace function public.claim_staff_invite()
 returns setof public.profiles
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user auth.users%rowtype;
  v_invite staff_invites%rowtype;
begin
  select * into v_user from auth.users where id = auth.uid();
  if not found or v_user.email_confirmed_at is null then
    return;
  end if;

  if not exists (select 1 from profiles where id = v_user.id) then
    select * into v_invite
    from staff_invites
    where lower(email) = lower(v_user.email) and used_at is null
    order by created_at desc
    limit 1;

    if found then
      insert into profiles (id, organization_id, full_name, role, email)
      values (
        v_user.id,
        v_invite.organization_id,
        coalesce(v_invite.full_name, split_part(v_user.email, '@', 1)),
        v_invite.role,
        v_user.email
      )
      on conflict (id) do nothing;
      update staff_invites set used_at = now() where id = v_invite.id;
    end if;
  end if;

  return query select * from profiles where id = v_user.id;
end;
$function$;

create or replace function public.claim_tenant_link()
 returns setof public.tenants
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user auth.users%rowtype;
begin
  select * into v_user from auth.users where id = auth.uid();
  if not found or v_user.email_confirmed_at is null then
    return;
  end if;

  update tenants set tenant_user_id = v_user.id
  where lower(email) = lower(v_user.email) and tenant_user_id is null;

  return query select * from tenants where tenant_user_id = v_user.id;
end;
$function$;

revoke execute on function public.claim_staff_invite() from public, anon;
revoke execute on function public.claim_tenant_link() from public, anon;
grant execute on function public.claim_staff_invite() to authenticated;
grant execute on function public.claim_tenant_link() to authenticated;

notify pgrst, 'reload schema';
