# Tests et environnements

## Tests automatiques (`npm test`)
Lancés à chaque push sur GitHub (onglet **Actions**) et avant chaque mise en ligne Netlify :
**si un test échoue, le site n'est pas redéployé**.

| Fichier | Ce qui est vérifié |
|---|---|
| `tests/finance.test.js` | retards calculés sur l'échéance, recouvrement, encaissements par mois, périodes |
| `tests/supabase.test.js` | lecture paginée (aucune troncature à 1000 lignes), messages de connexion, compte déjà existant, liens email |
| `tests/payslips-permissions.test.js` | rattachement des bulletins (jamais au hasard), permissions par rôle |

La logique testée est dans `lib/` (`finance.js`, `supabase.js`, `payslips.js`, `config.js`).
Toute nouvelle règle de calcul ou d'accès doit y être placée avec son test.

## Test d'isolation entre agences (base de données)
`supabase/tests/isolation_agences.sql` crée deux agences fictives et vérifie qu'aucune donnée ne passe
de l'une à l'autre (Direction, Maintenance, locataire, compte sans agence, visiteur non connecté).

- **Quand** : après chaque migration qui touche aux règles d'accès (RLS), et avant d'accueillir un client.
- **Comment** : Supabase → SQL Editor → coller le fichier → Run.
- **Résultat attendu** : une « erreur » `RAPPORT D'ISOLATION — 0 échec(s)` suivie de la liste des vérifications.
  Cette erreur est volontaire : elle annule tout, rien n'est conservé dans la base et aucun email ne part.

## Environnement de test (préproduction)
Aujourd'hui, toute mise en ligne part directement en production. Pour tester sans risque :

1. **Interface** : activer les *Branch deploys* dans Netlify (Site configuration → Build & deploy →
   Branches) pour une branche `staging`. Chaque push sur `staging` donne une adresse de prévisualisation.
   Attention : elle utilise la même base que la production.
2. **Base de données** : au passage en plan Pro de Supabase, activer le **Branching** (une base de test
   par branche Git, avec les migrations de `supabase/migrations`), puis faire pointer la branche `staging`
   de Netlify vers la base de test (variables d'environnement).
