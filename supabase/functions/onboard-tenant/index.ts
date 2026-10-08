// PropOS — accueil du locataire à la création d'un bail
// Déclenchée par le trigger public.trg_onboard_tenant (INSERT sur leases), qui envoie
// { type, table, record } avec l'en-tête x-cron-secret.
// Le lien d'invitation ouvre l'écran « Choisis ton mot de passe » de l'application.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const DIRECTION_EMAIL = Deno.env.get("DIRECTION_EMAIL")!;
const FROM_EMAIL = "PropOS <notifications@mypropos.app>";
const APP_URL = "https://mypropos.app/";
const FUNCTION_NAME = "onboard-tenant";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data, error } = await supabase.rpc("verify_cron_secret", { p_secret: secret });
  return !error && data === true;
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) console.error("Erreur envoi email:", await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });

  let lease: any;
  try {
    lease = (await req.json())?.record;
    if (!lease?.tenant_id) return new Response(JSON.stringify({ error: "tenant_id manquant" }), { status: 400 });

    const { data: tenant } = await supabase.from("tenants").select("id, email, full_name, tenant_user_id").eq("id", lease.tenant_id).single();
    const { data: property } = await supabase.from("properties").select("name").eq("id", lease.property_id).single();
    if (!tenant?.email) return new Response(JSON.stringify({ error: "Locataire sans email" }), { status: 400 });

    let accessHtml: string;
    if (tenant.tenant_user_id) {
      // Le locataire a déjà un espace : simple information
      accessHtml = `<p>Ce nouveau bail apparaît dans votre espace locataire :</p><p><a href="${APP_URL}">Accéder à mon espace</a></p>`;
    } else {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: "invite", email: tenant.email, options: { redirectTo: APP_URL },
      });
      if (linkError || !linkData?.properties?.action_link) {
        // Compte déjà existant (ex. inscrit lui-même) : il se connecte, l'accès sera relié automatiquement
        console.error("generateLink :", linkError?.message);
        accessHtml = `<p>Connectez-vous à votre espace avec votre adresse email (lien « Mot de passe oublié ? » si besoin) :</p>
                      <p><a href="${APP_URL}">Accéder à mon espace locataire</a></p>`;
      } else {
        accessHtml = `<p>Pour activer votre espace locataire, choisissez votre mot de passe :</p>
                      <p><a href="${linkData.properties.action_link}">Activer mon espace</a></p>
                      <p style="color:#888;font-size:12px;">Ce lien est personnel et utilisable une seule fois.</p>`;
      }
    }

    await sendEmail(
      tenant.email,
      "Bienvenue dans votre espace locataire",
      `<p>Bonjour ${esc(tenant.full_name)},</p>
       <p>Votre bail pour le bien <strong>${esc(property?.name ?? "")}</strong> vient d'être enregistré.</p>
       <p>Votre espace locataire vous permet de consulter vos documents et vos paiements, et de signaler un problème dans votre logement.</p>
       ${accessHtml}
       <p>Cordialement,<br/>La gestion locative</p>`,
    );

    return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[CRITICAL] ${FUNCTION_NAME}:`, msg, { lease_id: lease?.id });
    await sendEmail(DIRECTION_EMAIL, `🚨 Échec : ${FUNCTION_NAME}`,
      `<p>L'email d'accueil du locataire n'a pas pu être envoyé (bail ${esc(lease?.id ?? "?")}).</p><p>${esc(msg)}</p>`);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
