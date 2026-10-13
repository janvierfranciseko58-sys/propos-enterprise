// PropOS — notifications quotidiennes (cron 8h), agence par agence
//  1. passe en « en_retard » les échéances dépassées non payées
//  2. relance les locataires : au plus 3 rappels, espacés d'au moins 7 jours
//  3. récapitulatif à la Direction DE L'AGENCE quand des rappels sont partis
//  4. baux expirant sous 60 jours : le lundi uniquement
//  5. tickets urgents non résolus
// Appelée par pg_cron via public.call_propos_function() avec l'en-tête x-cron-secret.
// DIRECTION_EMAIL ne sert plus qu'aux alertes techniques destinées à l'exploitant de la plateforme.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const PLATFORM_ALERT_EMAIL = Deno.env.get("DIRECTION_EMAIL")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");
const SENDER = "notifications@mypropos.app";
const FUNCTION_NAME = "send-notifications";
const MAX_REMINDERS = 3;
const REMINDER_INTERVAL_DAYS = 7;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const parisDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
const frDate = (iso: string | null) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("fr-FR") : "—");
const euros = (n: unknown) => `${Number(n).toLocaleString("fr-FR")} €`;
const fromName = (orgName?: string) => `${(orgName || "PropOS").replace(/[<>"]/g, "")} via PropOS <${SENDER}>`;

type Org = { id: string; name: string; directionEmails: string[] };

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data, error } = await supabase.rpc("verify_cron_secret", { p_secret: secret });
  return !error && data === true;
}

// Agences et adresses de leur Direction
async function loadOrganizations(): Promise<Map<string, Org>> {
  const [{ data: orgs, error: e1 }, { data: dirs, error: e2 }] = await Promise.all([
    supabase.from("organizations").select("id, name"),
    supabase.from("profiles").select("organization_id, email").eq("role", "direction").not("email", "is", null),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  const map = new Map<string, Org>();
  for (const o of orgs ?? []) map.set(o.id, { id: o.id, name: o.name, directionEmails: [] });
  for (const d of dirs ?? []) map.get(d.organization_id)?.directionEmails.push(d.email);
  return map;
}

async function sendEmail(to: string | string[], subject: string, html: string, orgName?: string): Promise<boolean> {
  if (Array.isArray(to) && !to.length) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromName(orgName), to, subject, html }),
  });
  if (!res.ok) console.error("Erreur envoi email:", await res.text());
  return res.ok;
}

async function alertFailure(error: unknown, severity: "critical" | "minor", context?: Record<string, unknown>) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toISOString();
  console.error(`[${severity.toUpperCase()}] ${FUNCTION_NAME}:`, errorMessage, context ?? "");
  if (severity === "minor") return;
  let slackOk = false;
  if (SLACK_WEBHOOK_URL) {
    try {
      const res = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `🚨 Échec critique : ${FUNCTION_NAME} — ${timestamp} — ${errorMessage}` }),
      });
      slackOk = res.ok;
    } catch { /* email de secours ci-dessous */ }
  }
  if (!slackOk) {
    await sendEmail(PLATFORM_ALERT_EMAIL, `🚨 Échec : ${FUNCTION_NAME}`,
      `<h2>Erreur dans ${FUNCTION_NAME}</h2><p><strong>Horodatage :</strong> ${timestamp}</p><p><strong>Erreur :</strong> ${esc(errorMessage)}</p>`);
  }
}

const groupBy = <T extends { organization_id: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.organization_id, [...(m.get(r.organization_id) ?? []), r]);
  return m;
};

Deno.serve(async (req) => {
  if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });

  try {
    const today = parisDate();
    const now = Date.now();
    const orgs = await loadOrganizations();
    const results = { organizations: orgs.size, marked_late: 0, reminders_sent: 0, late_total: 0, expiring_leases: 0, urgent_tickets: 0 };

    // 1. Échéances dépassées non payées -> en_retard (toutes agences, sans envoi)
    try {
      const { data: marked, error } = await supabase
        .from("payments").update({ status: "en_retard" })
        .not("status", "in", "(paye,en_retard)").lt("due_date", today).select("id");
      if (error) throw error;
      results.marked_late = marked?.length ?? 0;
    } catch (e) {
      await alertFailure(e, "minor", { section: "mark_late" });
    }

    // 2. Relances locataires, puis récapitulatif à la Direction de chaque agence
    try {
      const { data: late, error } = await supabase
        .from("payments")
        .select("id, organization_id, amount, due_date, reminder_count, last_reminder_at, leases(tenants(full_name,email), properties(name))")
        .eq("status", "en_retard").order("due_date");
      if (error) throw error;
      results.late_total = late?.length ?? 0;

      for (const [orgId, payments] of groupBy((late ?? []) as any[])) {
        const org = orgs.get(orgId);
        const reminded: string[] = [];
        for (const p of payments) {
          const count = p.reminder_count ?? 0;
          const last = p.last_reminder_at ? new Date(p.last_reminder_at).getTime() : 0;
          if (count >= MAX_REMINDERS || (last && now - last < (REMINDER_INTERVAL_DAYS * 24 - 2) * 3600 * 1000)) continue;
          const tenant = p.leases?.tenants;
          const property = p.leases?.properties;
          if (!tenant?.email) continue;

          const isLast = count + 1 === MAX_REMINDERS;
          const ok = await sendEmail(
            tenant.email,
            isLast ? "Dernier rappel : loyer impayé" : "Rappel : loyer en attente de règlement",
            `<p>Bonjour ${esc(tenant.full_name)},</p>
             <p>Sauf erreur de notre part, nous n'avons pas encore reçu votre loyer de <b>${euros(p.amount)}</b>
             pour <b>${esc(property?.name ?? "votre logement")}</b>, échu le ${frDate(p.due_date)}.</p>
             <p>Merci de régulariser votre situation dans les meilleurs délais${isLast ? ", ou de contacter votre gestionnaire si vous rencontrez une difficulté" : ""}.
             Si votre règlement est en cours, merci de ne pas tenir compte de ce message.</p>
             <p>Cordialement,<br>${esc(org?.name ?? "La gestion locative")}</p>`,
            org?.name,
          );
          if (ok) {
            await supabase.from("payments")
              .update({ reminder_count: count + 1, last_reminder_at: new Date().toISOString() }).eq("id", p.id);
            results.reminders_sent++;
            reminded.push(`<li>${esc(tenant.full_name)} — ${esc(property?.name ?? "-")} — ${euros(p.amount)} (échu le ${frDate(p.due_date)}) — rappel ${count + 1}/${MAX_REMINDERS}</li>`);
          }
        }
        if (reminded.length && org?.directionEmails.length) {
          await sendEmail(org.directionEmails,
            `⚠️ ${reminded.length} rappel(s) de loyer envoyé(s) — ${payments.length} impayé(s) au total`,
            `<p>Rappels envoyés aujourd'hui :</p><ul>${reminded.join("")}</ul>
             <p>Les échéances ayant déjà reçu ${MAX_REMINDERS} rappels ne sont plus relancées automatiquement.</p>`, org.name);
        }
      }
    } catch (e) {
      await alertFailure(e, "minor", { section: "late_payments" });
    }

    // 3. Baux expirant sous 60 jours — le lundi uniquement
    const isMonday = new Date().toLocaleDateString("en-US", { timeZone: "Europe/Paris", weekday: "short" }) === "Mon";
    if (isMonday) {
      try {
        const in60 = parisDate(new Date(now + 60 * 24 * 3600 * 1000));
        const { data: expiring, error } = await supabase
          .from("leases").select("id, organization_id, end_date, tenants(full_name), properties(name)")
          .eq("status", "actif").not("end_date", "is", null).lte("end_date", in60).order("end_date");
        if (error) throw error;
        results.expiring_leases = expiring?.length ?? 0;
        for (const [orgId, leases] of groupBy((expiring ?? []) as any[])) {
          const org = orgs.get(orgId);
          if (!org?.directionEmails.length) continue;
          const recap = leases.map((l: any) => `<li>${esc(l.tenants?.full_name ?? "-")} — ${esc(l.properties?.name ?? "-")} — fin le ${frDate(l.end_date)}</li>`).join("");
          await sendEmail(org.directionEmails, `📅 ${leases.length} bail(aux) expirant sous 60 jours`, `<ul>${recap}</ul>`, org.name);
        }
      } catch (e) {
        await alertFailure(e, "minor", { section: "expiring_leases" });
      }
    }

    // 4. Tickets urgents non résolus
    try {
      const { data: urgent, error } = await supabase
        .from("maintenance_tickets").select("id, organization_id, description, properties(name)")
        .eq("priority", "urgent").neq("status", "resolu");
      if (error) throw error;
      results.urgent_tickets = urgent?.length ?? 0;
      for (const [orgId, tickets] of groupBy((urgent ?? []) as any[])) {
        const org = orgs.get(orgId);
        if (!org?.directionEmails.length) continue;
        const recap = tickets.map((t: any) => `<li>${esc(t.properties?.name ?? "-")} — ${esc(t.description ?? "")}</li>`).join("");
        await sendEmail(org.directionEmails, `🚨 ${tickets.length} ticket(s) urgent(s) en attente`, `<ul>${recap}</ul>`, org.name);
      }
    } catch (e) {
      await alertFailure(e, "minor", { section: "urgent_tickets" });
    }

    return new Response(JSON.stringify({ ok: true, ...results }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    await alertFailure(error, "critical");
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), { status: 500 });
  }
});
