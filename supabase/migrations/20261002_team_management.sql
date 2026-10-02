-- ============================================================================
-- Gestion des membres de l'équipe par la Direction (2026-10-02)
-- ============================================================================

-- Email affiché dans la liste des membres (copié depuis auth.users)
alter table public.profiles add column if not exists email text;
update public.profiles p set email = u.email
from auth.users u where u.id = p.id and p.email is null;

create or replace function public.link_staff_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invite staff_invites%rowtype;
begin
  select * into v_invite
  from staff_invites
  where lower(email) = lower(new.email) and used_at is null
  order by created_at desc
  limit 1;

  if found then
    insert into profiles (id, organization_id, full_name, role, email)
    values (
      new.id,
      v_invite.organization_id,
      coalesce(v_invite.full_name, split_part(new.email, '@', 1)),
      v_invite.role,
      new.email
    )
    on conflict (id) do nothing;

    update staff_invites set used_at = now() where id = v_invite.id;
  end if;

  return new;
exception when others then
  -- Ne jamais bloquer la création du compte : si le rattachement échoue,
  -- on le fera manuellement ensuite, mais l'inscription doit toujours réussir.
  return new;
end;
$function$;

-- La Direction peut changer le rôle ou retirer l'accès des autres membres de
-- son organisation, jamais le sien (pour ne pas perdre l'accès Direction).
create policy profiles_update_direction on public.profiles for update using (
  organization_id = (select auth_org())
  and (select auth_role()) = 'direction'::user_role
  and id <> (select auth.uid())
) with check (
  organization_id = (select auth_org())
  and id <> (select auth.uid())
);

create policy profiles_delete_direction on public.profiles for delete using (
  organization_id = (select auth_org())
  and (select auth_role()) = 'direction'::user_role
  and id <> (select auth.uid())
);

-- Retirer un membre qui a lui-même envoyé des invitations ne doit pas échouer
alter table public.staff_invites drop constraint if exists staff_invites_invited_by_fkey;
alter table public.staff_invites add constraint staff_invites_invited_by_fkey
  foreign key (invited_by) references public.profiles(id) on delete set null;
