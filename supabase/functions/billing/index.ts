// PropOS — abonnement de l'agence (appelée par l'application, jeton de l'utilisateur requis)
// POST { action: "info" | "checkout" | "portal" } — réservé à la Direction de l'agence.
// Secrets : STRIPE_SECRET_KEY, STRIPE_PRICE_ID (prix récurrent par lot), APP_URL (facultatif)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID");
const APP_URL = (Deno.env.get("APP_URL") ?? "https://mypropos.app").replace(/\/$/, "");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }) : null;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Montant mensuel estimé (en centimes) pour un nombre de lots, d'après la grille du prix Stripe
function estimate(price: Stripe.Price, quantity: number): number | null {
  if (price.billing_scheme === "per_unit") return (price.unit_amount ?? 0) * quantity;
  const tiers = price.tiers ?? [];
  if (price.tiers_mode === "volume") {
    const tier = tiers.find((t) => t.up_to === null || quantity <= t.up_to) ?? tiers[tiers.length - 1];
    return tier ? (tier.flat_amount ?? 0) + (tier.unit_amount ?? 0) * quantity : null;
  }
  // graduated : chaque tranche facturée à son propre tarif
  let total = 0, previous = 0;
  for (const t of tiers) {
    const upper = t.up_to ?? Infinity;
    const inTier = Math.max(0, Math.min(quantity, upper) - previous);
    if (inTier > 0 || previous === 0) total += (t.flat_amount ?? 0) + (t.unit_amount ?? 0) * inTier;
    if (quantity <= upper) break;
    previous = upper;
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!stripe || !STRIPE_PRICE_ID) return reply({ error: "La facturation n'est pas encore configurée." }, 503);

  try {
    // 1. Utilisateur connecté et membre de la Direction
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) return reply({ error: "Session expirée, reconnecte-toi." }, 401);
    const { data: profile } = await supabase.from("profiles").select("organization_id, role").eq("id", user.id).single();
    if (!profile || profile.role !== "direction") return reply({ error: "Réservé à la Direction de l'agence." }, 403);

    const { data: org, error: orgError } = await supabase.from("organizations")
      .select("id, name, subscription_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_end")
      .eq("id", profile.organization_id).single();
    if (orgError || !org) return reply({ error: "Agence introuvable." }, 404);

    const { count: lots } = await supabase.from("properties")
      .select("id", { count: "exact", head: true }).eq("organization_id", org.id);
    const quantity = Math.max(1, lots ?? 0);
    const { action } = await req.json().catch(() => ({ action: "info" }));

    if (action === "info") {
      const price = await stripe.prices.retrieve(STRIPE_PRICE_ID, { expand: ["tiers"] });
      return reply({
        status: org.subscription_status,
        trial_ends_at: org.trial_ends_at,
        current_period_end: org.current_period_end,
        lots: lots ?? 0,
        estimate_cents: estimate(price, quantity),
        currency: price.currency,
        has_subscription: !!org.stripe_subscription_id,
      });
    }

    // Client Stripe de l'agence (créé une seule fois)
    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: org.name, metadata: { organization_id: org.id },
      });
      customerId = customer.id;
      await supabase.from("organizations").update({ stripe_customer_id: customerId }).eq("id", org.id);
    }

    if (action === "portal") {
      const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${APP_URL}/?billing=portal` });
      return reply({ url: portal.url });
    }

    if (action === "checkout") {
      if (org.stripe_subscription_id && ["active", "trialing", "past_due"].includes(org.subscription_status)) {
        return reply({ error: "Un abonnement est déjà en cours : utilise « Gérer mon abonnement »." }, 409);
      }
      // L'essai gratuit déjà commencé dans PropOS est conservé : premier prélèvement à sa fin
      const trialEnd = org.trial_ends_at ? Math.floor(new Date(org.trial_ends_at).getTime() / 1000) : 0;
      const keepTrial = org.subscription_status === "trialing" && trialEnd > Date.now() / 1000 + 48 * 3600;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: org.id,
        line_items: [{ price: STRIPE_PRICE_ID, quantity }],
        subscription_data: { metadata: { organization_id: org.id }, ...(keepTrial ? { trial_end: trialEnd } : {}) },
        allow_promotion_codes: true,
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        locale: "fr",
        success_url: `${APP_URL}/?billing=success`,
        cancel_url: `${APP_URL}/?billing=cancel`,
      });
      return reply({ url: session.url });
    }

    return reply({ error: "Action inconnue." }, 400);
  } catch (error) {
    console.error("[billing]", error instanceof Error ? error.message : error);
    return reply({ error: "Le service de paiement est momentanément indisponible." }, 502);
  }
});
