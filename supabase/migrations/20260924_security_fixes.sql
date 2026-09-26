-- ============================================================================
-- PropOS Enterprise — correctifs de sécurité (2026-09-24)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rattachement équipe / locataire uniquement APRÈS confirmation de l'email
--    Avant : les triggers s'exécutaient à la création du compte, donc n'importe
--    qui connaissant l'email d'un invité ou d'un locataire pouvait en prendre
--    la place.
-- ----------------------------------------------------------------------------
drop trigger if exists on_auth_user_created_link_tenant on auth.users;
drop trigger if exists on_auth_user_created_link_staff on auth.users;

-- Compte créé déjà confirmé (ex. invitation admin, connexion OAuth)
create trigger on_auth_user_confirmed_link_tenant_insert
  after insert on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.link_tenant_user();
create trigger on_auth_user_confirmed_link_staff_insert
  after insert on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.link_staff_user();

-- Compte confirmé via le lien reçu par email
create trigger on_auth_user_confirmed_link_tenant
  after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.link_tenant_user();
create trigger on_auth_user_confirmed_link_staff
  after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.link_staff_user();

-- ----------------------------------------------------------------------------
-- 2. Le rôle Maintenance ne voit plus les paiements, locataires, baux et
--    documents (cohérent avec PERMISSIONS dans main.jsx).
-- ----------------------------------------------------------------------------
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select using (
  ((organization_id = (select auth_org()))
    and ((select auth_role()) = any (array['direction','finance','gestion_locative']::user_role[])))
  or (lease_id in (select leases.id from leases where leases.tenant_id = (select current_tenant_id())))
);

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants for select using (
  ((organization_id = (select auth_org()))
    and ((select auth_role()) = any (array['direction','finance','gestion_locative']::user_role[])))
  or (tenant_user_id = (select auth.uid()))
);

drop policy if exists leases_select on public.leases;
create policy leases_select on public.leases for select using (
  ((organization_id = (select auth_org()))
    and ((select auth_role()) = any (array['direction','finance','gestion_locative']::user_role[])))
  or (tenant_id = (select current_tenant_id()))
);

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select using (
  ((organization_id = (select auth_org()))
    and ((select auth_role()) = any (array['direction','finance','gestion_locative']::user_role[])))
  or (tenant_id = (select current_tenant_id()))
  or (lease_id in (select leases.id from leases where leases.tenant_id = (select current_tenant_id())))
);

-- ----------------------------------------------------------------------------
-- 3. Stockage "documents" : les locataires peuvent ouvrir LEURS documents,
--    la Maintenance n'y a plus accès.
-- ----------------------------------------------------------------------------
drop policy if exists "Lecture documents de sa propre organisation" on storage.objects;
create policy "Lecture documents de sa propre organisation" on storage.objects for select using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = (public.auth_org())::text
  and public.auth_role() = any (array['direction','finance','gestion_locative']::user_role[])
);
create policy "Locataire: lecture de ses documents" on storage.objects for select using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.documents d
    where d.storage_path = storage.objects.name
      and (d.tenant_id = public.current_tenant_id()
           or d.lease_id in (select l.id from public.leases l where l.tenant_id = public.current_tenant_id()))
  )
);

-- ----------------------------------------------------------------------------
-- 4. Stockage "payslips" : cloisonnement par organisation.
--    Nouveaux fichiers : <organization_id>/<employee_id>-<période>.pdf
--    Anciens fichiers (à la racine) : lisibles seulement si la fiche de paie
--    qui les référence appartient à l'organisation.
-- ----------------------------------------------------------------------------
drop policy if exists "Direction: lecture fiches de paie" on storage.objects;
drop policy if exists "Direction: mise a jour fiches de paie" on storage.objects;
drop policy if exists "Direction: suppression fiches de paie" on storage.objects;
drop policy if exists "Direction: upload fiches de paie" on storage.objects;

create policy "Direction: lecture fiches de paie" on storage.objects for select using (
  bucket_id = 'payslips' and public.auth_role() = 'direction'::user_role
  and ((storage.foldername(name))[1] = (public.auth_org())::text
       or exists (select 1 from public.payslips p
                  where p.pdf_path = storage.objects.name and p.organization_id = public.auth_org()))
);
create policy "Direction: upload fiches de paie" on storage.objects for insert with check (
  bucket_id = 'payslips' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
create policy "Direction: mise a jour fiches de paie" on storage.objects for update using (
  bucket_id = 'payslips' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
) with check (
  bucket_id = 'payslips' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
create policy "Direction: suppression fiches de paie" on storage.objects for delete using (
  bucket_id = 'payslips' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);

-- ----------------------------------------------------------------------------
-- 5. Stockage "employee-photos" (manquant). Lecture publique par URL (l'app
--    affiche les photos via l'URL publique) ; écriture réservée à la Direction,
--    dans le dossier de son organisation.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('employee-photos', 'employee-photos', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

-- Requis par l'envoi en mode upsert (x-upsert: true)
create policy "Direction: lecture photos employes" on storage.objects for select using (
  bucket_id = 'employee-photos' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
create policy "Direction: upload photos employes" on storage.objects for insert with check (
  bucket_id = 'employee-photos' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
create policy "Direction: mise a jour photos employes" on storage.objects for update using (
  bucket_id = 'employee-photos' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
) with check (
  bucket_id = 'employee-photos' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
create policy "Direction: suppression photos employes" on storage.objects for delete using (
  bucket_id = 'employee-photos' and public.auth_role() = 'direction'::user_role
  and (storage.foldername(name))[1] = (public.auth_org())::text
);
