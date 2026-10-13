// PropOS — synchronisation quotidienne du nombre de lots facturés (cron 3h30)
// Met à jour la quantité de l'abonnement Stripe de chaque agence d'après son nombre de biens.
// Appelée par pg_cron via public.call_propos_function() avec l'en-tête x-cron-secret.
// Secrets : STRIPE_SECRET_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data, error } = await supabase.rpc("verify_cron_secret", { p_secret: secret });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });
  if (!STRIPE_SECRET_KEY) return new Response(JSON.stringify({ skipped: "facturation non configurée" }), { status: 200 });
  const stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  const { data: orgs, error } = await supabase.from("organizations")
    .select("id, stripe_subscription_id, billed_quantity")
    .not("stripe_subscription_id", "is", null)
    .in("subscription_status", ["trialing", "active", "past_due"]);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let updated = 0;
  const failed: string[] = [];
  for (const org of orgs ?? []) {
    try {
      const { count } = await supabase.from("properties")
        .select("id", { count: "exact", head: true }).eq("organization_id", org.id);
      const quantity = Math.max(1, count ?? 0);
      if (quantity === org.billed_quantity) continue;

      const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id!);
      const item = sub.items.data[0];
      if (item.quantity !== quantity) {
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, quantity }],
          proration_behavior: "create_prorations", // ajustement au prorata sur la facture suivante
        });
      }
      await supabase.from("organizations").update({ billed_quantity: quantity }).eq("id", org.id);
      updated++;
    } catch (e) {
      console.error("[billing-sync]", org.id, e instanceof Error ? e.message : e);
      failed.push(org.id);
    }
  }
  return new Response(JSON.stringify({ checked: orgs?.length ?? 0, updated, failed: failed.length }),
    { headers: { "Content-Type": "application/json" } });
});
