// PropOS — événements Stripe (abonnement créé, modifié, résilié, paiement échoué)
// Appelée par Stripe : la signature est vérifiée avec STRIPE_WEBHOOK_SECRET (pas de jeton utilisateur).
// Secrets : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
// Sans clé, Stripe refuse de s'initialiser : la fonction reste alors inactive (503)
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }) : null;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

// Statut Stripe -> statut PropOS
function toStatus(s: Stripe.Subscription.Status): "trialing" | "active" | "past_due" | "canceled" {
  if (s === "trialing") return "trialing";
  if (s === "active") return "active";
  if (s === "past_due" || s === "unpaid" || s === "incomplete") return "past_due";
  return "canceled"; // canceled, incomplete_expired, paused
}

async function applySubscription(sub: Stripe.Subscription, organizationIdHint?: string | null) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const orgId = organizationIdHint ?? sub.metadata?.organization_id ?? null;
  const item = sub.items?.data?.[0] as any;
  const periodEnd = (sub as any).current_period_end ?? item?.current_period_end ?? null;
  const status = toStatus(sub.status);

  const update: Record<string, unknown> = {
    stripe_customer_id: customerId,
    stripe_subscription_id: status === "canceled" ? null : sub.id,
    subscription_status: status,
    billed_quantity: item?.quantity ?? null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
  if (status === "trialing" && sub.trial_end) update.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
  if (status === "active") update.trial_ends_at = null;

  const query = supabase.from("organizations").update(update);
  const { data, error } = await (orgId ? query.eq("id", orgId) : query.eq("stripe_customer_id", customerId)).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) console.error("[stripe-webhook] aucune agence pour", customerId, orgId);
}

Deno.serve(async (req) => {
  if (!stripe) return new Response("Facturation non configurée", { status: 503 });
  const signature = req.headers.get("Stripe-Signature");
  if (!signature || !WEBHOOK_SECRET) return new Response("Signature manquante", { status: 400 });

  let event: Stripe.Event;
  const body = await req.text();
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    console.error("[stripe-webhook] signature invalide :", e instanceof Error ? e.message : e);
    return new Response("Signature invalide", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await stripe!.subscriptions.retrieve(session.subscription as string);
          await applySubscription(sub, session.client_reference_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        break; // événement ignoré
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    // 500 : Stripe renverra l'événement plus tard
    console.error("[stripe-webhook]", event.type, e instanceof Error ? e.message : e);
    return new Response("Erreur de traitement", { status: 500 });
  }
});
