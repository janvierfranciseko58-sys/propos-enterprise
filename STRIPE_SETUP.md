# Activer les abonnements Stripe

Le code est prêt et déployé, mais inactif tant que ces étapes ne sont pas faites.
Sans elles, aucune agence n'est bloquée en fin d'essai (`BILLING_ENABLED = false` dans `main.jsx`).

## 1. Compte Stripe
Créer le compte sur https://dashboard.stripe.com et l'activer (identité, IBAN).
Faire d'abord toutes les étapes en **mode test**, puis les refaire en mode réel.

## 2. Produit et prix par lot
Stripe → **Catalogue de produits → Ajouter un produit**
- Nom : `PropOS — gestion locative`
- Tarification : **Récurrent, mensuel**, modèle **Par paliers** (« Graduated »)
  - Palier 1 : de 1 à 16 lots → **forfait 49 €**, 0 € par unité
  - Palier 2 : de 17 à ∞ → **3 €** par unité
- Copier l'identifiant du prix : `price_…`

Les montants ci-dessus sont un exemple : ils se changent dans Stripe sans toucher au code.

## 3. Webhook
Stripe → **Développeurs → Webhooks → Ajouter un endpoint**
- URL : `https://vdpvejwdexclcuwfiout.supabase.co/functions/v1/stripe-webhook`
- Événements : `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`
- Copier le **secret de signature** : `whsec_…`

## 4. Portail client
Stripe → **Paramètres → Facturation → Portail client** : activer la mise à jour du moyen de paiement,
l'historique des factures et la résiliation.

## 5. Clés dans Supabase (jamais dans le code)
Supabase → **Edge Functions → Secrets** :

| Nom | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | clé secrète Stripe (`sk_…` ou clé restreinte `rk_…`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (étape 3) |
| `STRIPE_PRICE_ID` | `price_…` (étape 2) |

## 6. Allumer la facturation dans l'application
Dans `main.jsx` : `const BILLING_ENABLED = true;` puis commit / push (Netlify redéploie).

## 7. Tester (mode test)
Créer une agence d'essai → **Abonnement → S'abonner** → carte de test `4242 4242 4242 4242`.
Vérifier que le statut passe à « Abonnement actif » et que le webhook apparaît en succès dans Stripe.
