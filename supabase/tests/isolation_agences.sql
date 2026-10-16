-- ============================================================================
-- Test d'isolation entre agences (règles RLS)
-- Crée deux agences fictives, se fait passer pour chaque type d'utilisateur et vérifie
-- qu'aucune donnée ne fuit d'une agence à l'autre.
--
-- SANS EFFET SUR LA BASE : le bloc se termine TOUJOURS par une exception qui annule
-- toute la transaction (données de test, triggers, emails en file d'attente) et dont le
-- message contient le rapport. Résultat attendu : « 0 échec ».
-- Exécution : Supabase → SQL Editor → coller → Run (ou via l'outil execute_sql).
-- ============================================================================
do $$
declare
  org_a uuid := gen_random_uuid();  org_b uuid := gen_random_uuid();
  dir_a uuid := gen_random_uuid();  dir_b uuid := gen_random_uuid();
  mnt_a uuid := gen_random_uuid();  loc_b_user uuid := gen_random_uuid();  inconnu uuid := gen_random_uuid();
  bien_a uuid := gen_random_uuid(); bien_b uuid := gen_random_uuid();
  loc_a uuid := gen_random_uuid();  loc_b uuid := gen_random_uuid();
  bail_a uuid := gen_random_uuid(); bail_b uuid := gen_random_uuid();
  rapport text := '';
  echecs int := 0;
  n int;
  refuse boolean;
begin
  -- ---------- Données de test (rôle administrateur, sans RLS) ----------
  insert into auth.users (id, email, email_confirmed_at, aud, role) values
    (dir_a, 'dir-a@isolation.test', now(), 'authenticated', 'authenticated'),
    (dir_b, 'dir-b@isolation.test', now(), 'authenticated', 'authenticated'),
    (mnt_a, 'mnt-a@isolation.test', now(), 'authenticated', 'authenticated'),
    (loc_b_user, 'loc-b@isolation.test', now(), 'authenticated', 'authenticated'),
    (inconnu, 'inconnu@isolation.test', now(), 'authenticated', 'authenticated');
  insert into organizations (id, name, subscription_status) values (org_a, 'TEST Agence A', 'active'), (org_b, 'TEST Agence B', 'active');
  insert into profiles (id, organization_id, full_name, role, email) values
    (dir_a, org_a, 'Direction A', 'direction', 'dir-a@isolation.test'),
    (dir_b, org_b, 'Direction B', 'direction', 'dir-b@isolation.test'),
    (mnt_a, org_a, 'Maintenance A', 'maintenance', 'mnt-a@isolation.test');
  insert into buildings (organization_id, name, address) values (org_a, 'Immeuble A', 'A'), (org_b, 'Immeuble B', 'B');
  insert into properties (id, organization_id, reference, name, address, rent) values
    (bien_a, org_a, 'A-1', 'Bien A', 'A', 1000), (bien_b, org_b, 'B-1', 'Bien B', 'B', 2000);
  insert into tenants (id, organization_id, full_name, email, tenant_user_id) values
    (loc_a, org_a, 'Locataire A', 'loc-a@isolation.test', null),
    (loc_b, org_b, 'Locataire B', 'loc-b@isolation.test', loc_b_user);
  insert into leases (id, organization_id, property_id, tenant_id, rent, start_date, status) values
    (bail_a, org_a, bien_a, loc_a, 1000, current_date, 'actif'),
    (bail_b, org_b, bien_b, loc_b, 2000, current_date, 'actif');
  insert into payments (organization_id, lease_id, amount, due_date, status) values
    (org_a, bail_a, 1000, current_date, 'en_attente'), (org_b, bail_b, 2000, current_date, 'en_attente');
  insert into employees (organization_id, full_name, role_title, department, hired_date, monthly_gross_salary) values
    (org_a, 'Salarié A', 'Concierge', 'Conciergerie', current_date, 2000),
    (org_b, 'Salarié B', 'Concierge', 'Conciergerie', current_date, 2500);
  insert into maintenance_tickets (organization_id, property_id, category) values (org_a, bien_a, 'plomberie'), (org_b, bien_b, 'plomberie');

  -- ======================= Direction de l'agence A =======================
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', dir_a, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', dir_a::text, true);

  select count(*) into n from organizations;                           if n = 1 then rapport := rapport || E'OK    Direction A ne voit que sa propre agence\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Direction A voit %s agences\n', n); end if;
  select count(*) into n from properties;                              if n = 1 then rapport := rapport || E'OK    Direction A ne voit que ses biens (aucun bien d''une autre agence)\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Direction A voit %s biens\n', n); end if;
  select count(*) into n from payments where organization_id = org_b; if n = 0 then rapport := rapport || E'OK    Direction A ne voit pas les paiements de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A voit les paiements de B\n'; end if;
  select count(*) into n from tenants where organization_id = org_b;  if n = 0 then rapport := rapport || E'OK    Direction A ne voit pas les locataires de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A voit les locataires de B\n'; end if;
  select count(*) into n from employees where organization_id = org_b; if n = 0 then rapport := rapport || E'OK    Direction A ne voit pas les salariés de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A voit les salariés de B\n'; end if;
  select count(*) into n from maintenance_tickets where organization_id = org_b; if n = 0 then rapport := rapport || E'OK    Direction A ne voit pas les tickets de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A voit les tickets de B\n'; end if;

  refuse := false;
  begin insert into properties (organization_id, reference, name, address, rent) values (org_b, 'X', 'Intrus', 'X', 1);
  exception when others then refuse := true; end;
  if refuse then rapport := rapport || E'OK    Direction A ne peut pas créer de bien dans l''agence B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a créé un bien dans B\n'; end if;

  update properties set rent = 1 where id = bien_b; get diagnostics n = row_count;
  if n = 0 then rapport := rapport || E'OK    Direction A ne peut pas modifier un bien de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a modifié un bien de B\n'; end if;
  delete from tenants where id = loc_b; get diagnostics n = row_count;
  if n = 0 then rapport := rapport || E'OK    Direction A ne peut pas supprimer un locataire de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a supprimé un locataire de B\n'; end if;
  update profiles set role = 'maintenance' where id = dir_b; get diagnostics n = row_count;
  if n = 0 then rapport := rapport || E'OK    Direction A ne peut pas changer le rôle d''un membre de B\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a changé un rôle dans B\n'; end if;
  update profiles set role = 'finance' where id = dir_a; get diagnostics n = row_count;
  if n = 0 then rapport := rapport || E'OK    Direction A ne peut pas modifier son propre rôle\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a modifié son propre rôle\n'; end if;

  refuse := false;
  begin update organizations set subscription_status = 'active', trial_ends_at = null where id = org_a;
  exception when others then refuse := true; end;
  if refuse then rapport := rapport || E'OK    Direction A ne peut pas s''attribuer un abonnement\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Direction A a modifié son abonnement\n'; end if;

  refuse := false;
  begin perform public.create_organization('Deuxième agence', 'X');
  exception when others then refuse := true; end;
  if refuse then rapport := rapport || E'OK    Un membre d''agence ne peut pas créer une seconde agence\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Un membre a créé une seconde agence\n'; end if;

  refuse := false;
  begin perform public.verify_cron_secret('essai');
  exception when others then refuse := true; end;
  if refuse then rapport := rapport || E'OK    Un utilisateur ne peut pas interroger le secret des automatismes\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC verify_cron_secret accessible aux utilisateurs\n'; end if;

  -- ======================= Maintenance de l'agence A =======================
  perform set_config('request.jwt.claims', json_build_object('sub', mnt_a, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', mnt_a::text, true);
  select count(*) into n from payments;  if n = 0 then rapport := rapport || E'OK    Maintenance ne voit aucun paiement\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Maintenance voit %s paiements\n', n); end if;
  select count(*) into n from tenants;   if n = 0 then rapport := rapport || E'OK    Maintenance ne voit aucun locataire\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Maintenance voit des locataires\n'; end if;
  select count(*) into n from employees; if n = 0 then rapport := rapport || E'OK    Maintenance ne voit pas les salariés (RH)\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Maintenance voit les salariés\n'; end if;
  select count(*) into n from maintenance_tickets; if n = 1 then rapport := rapport || E'OK    Maintenance voit les tickets de son agence uniquement\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Maintenance voit %s tickets\n', n); end if;

  -- ======================= Locataire de l'agence B =======================
  perform set_config('request.jwt.claims', json_build_object('sub', loc_b_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', loc_b_user::text, true);
  select count(*) into n from leases;     if n = 1 then rapport := rapport || E'OK    Le locataire ne voit que son bail\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Le locataire voit %s baux\n', n); end if;
  select count(*) into n from payments;   if n = 1 then rapport := rapport || E'OK    Le locataire ne voit que ses paiements\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Le locataire voit %s paiements\n', n); end if;
  select count(*) into n from tenants;    if n = 1 then rapport := rapport || E'OK    Le locataire ne voit que sa propre fiche\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Le locataire voit %s fiches\n', n); end if;
  select count(*) into n from employees;  if n = 0 then rapport := rapport || E'OK    Le locataire ne voit aucun salarié\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Le locataire voit des salariés\n'; end if;
  select count(*) into n from organizations; if n = 0 then rapport := rapport || E'OK    Le locataire ne voit pas les informations de l''agence\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Le locataire voit l''agence\n'; end if;

  -- ======================= Compte inconnu (ni équipe, ni locataire) =======================
  perform set_config('request.jwt.claims', json_build_object('sub', inconnu, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', inconnu::text, true);
  select (select count(*) from properties) + (select count(*) from payments) + (select count(*) from tenants) + (select count(*) from organizations) into n;
  if n = 0 then rapport := rapport || E'OK    Un compte sans agence ne voit rien\n'; else echecs := echecs + 1; rapport := rapport || format(E'ÉCHEC Un compte sans agence voit %s lignes\n', n); end if;

  -- ======================= Visiteur non connecté =======================
  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  refuse := false;
  begin select count(*) into n from properties; if n = 0 then refuse := true; end if;
  exception when others then refuse := true; end;
  if refuse then rapport := rapport || E'OK    Un visiteur non connecté ne lit aucun bien\n'; else echecs := echecs + 1; rapport := rapport || E'ÉCHEC Un visiteur non connecté lit des biens\n'; end if;
  execute 'reset role';

  -- Toujours annuler : le rapport est transmis dans le message d'erreur
  raise exception E'RAPPORT D''ISOLATION — % échec(s)\n%', echecs, rapport;
end $$;
