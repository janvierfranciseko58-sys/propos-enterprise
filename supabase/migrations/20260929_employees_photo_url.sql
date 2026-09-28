-- La fiche employé envoie photo_url, mais la colonne n'existait pas :
-- toute création ou modification d'employé était refusée.
alter table public.employees add column if not exists photo_url text;
notify pgrst, 'reload schema';
