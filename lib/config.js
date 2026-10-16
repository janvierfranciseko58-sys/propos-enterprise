// Configuration de l'application
export const SUPABASE_URL = "https://vdpvejwdexclcuwfiout.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_edQZanOgXvZzl4hsqFRc9w_Q9S3WKqP";
// Abonnements Stripe : passer à true une fois Stripe configuré (voir STRIPE_SETUP.md).
// Tant que c'est false, aucune agence n'est bloquée en fin d'essai.
export const BILLING_ENABLED = false;

// Rôles et onglets accessibles
export const roles = { direction: "Direction", finance: "Finance", gestion_locative: "Gestion Locative", maintenance: "Maintenance" };
export const PERMISSIONS = {
  direction: ["overview", "buildings", "portfolio", "tenants", "finance", "maintenance", "hr", "billing"],
  finance: ["overview", "buildings", "portfolio", "tenants", "finance"],
  gestion_locative: ["overview", "buildings", "portfolio", "tenants", "maintenance"],
  maintenance: ["overview", "maintenance"],
};
