// PropOS — rapport financier du mois écoulé (cron le 1er du mois, 8h), un rapport par agence
// Mêmes définitions que l'onglet Finance de l'application :
//  - loyers appelés = échéances du mois ; encaissés = ceux payés
//  - encaissements reçus = paiements dont la date de paiement tombe dans le mois
//  - impayés à ce jour = non payés dont l'échéance est dépassée, toutes périodes
// Appelée par pg_cron via public.call_propos_function() avec l'en-tête x-cron-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const PLATFORM_ALERT_EMAIL = Deno.env.get("DIRECTION_EMAIL")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");
const SENDER = "notifications@mypropos.app";
const FUNCTION_NAME = "monthly-financial-report";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const parisDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const euros = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;
const fromName = (orgName?: string) => `${(orgName || "PropOS").replace(/[<>"]/g, "")} via PropOS <${SENDER}>`;

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data, error } = await supabase.rpc("verify_cron_secret", { p_secret: secret });
  return !error && data === true;
}

async function sendEmail(to: string | string[], subject: string, html: string, orgName?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromName(orgName), to, subject, html }),
  });
  if (!res.ok) console.error("Erreur envoi email:", await res.text());
}

async function alertCritical(error: unknown, context?: Record<string, unknown>) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toISOString();
  console.error(`[CRITICAL] ${FUNCTION_NAME}:`, errorMessage, context ?? "");
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
      `<h2>Erreur dans ${FUNCTION_NAME}</h2><p><strong>Horodatage :</strong> ${timestamp}</p><p><strong>Erreur :</strong> ${esc(errorMessage)}</p>${context ? `<pre>${esc(JSON.stringify(context))}</pre>` : ""}`);
  }
}

// Lecture paginée : PostgREST plafonne chaque réponse (1000 lignes par défaut)
async function fetchAll<T>(build: (from: number, to: number) => any, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

type P = { amount: number; status: string; due_date: string | null; paid_date: string | null; leases: { properties: { name: string } | null } | null };
const SELECT = "amount, status, due_date, paid_date, leases(properties(name))";
const cell = "padding:6px 12px;border-bottom:1px solid #eee;";

function buildReport(orgName: string, periodLabel: string, due: P[], received: P[], overdue: P[]) {
  const sum = (list: P[]) => list.reduce((s, p) => s + Number(p.amount || 0), 0);
  const dueTotal = sum(due);
  const dueCollected = sum(due.filter((p) => p.status === "paye"));
  const recovery = dueTotal ? Math.round((dueCollected / dueTotal) * 100) : null;

  const byProperty: Record<string, { appele: number; encaisse: number; restant: number }> = {};
  for (const p of due) {
    const name = p.leases?.properties?.name ?? "Bien inconnu";
    byProperty[name] ??= { appele: 0, encaisse: 0, restant: 0 };
    byProperty[name].appele += Number(p.amount);
    if (p.status === "paye") byProperty[name].encaisse += Number(p.amount);
    else byProperty[name].restant += Number(p.amount);
  }
  const rows = Object.entries(byProperty).sort(([a], [b]) => a.localeCompare(b, "fr"))
    .map(([name, v]) => `<tr><td style="${cell}">${esc(name)}</td><td style="${cell}text-align:right;">${euros(v.appele)}</td>
      <td style="${cell}text-align:right;">${euros(v.encaisse)}</td>
      <td style="${cell}text-align:right;color:${v.restant > 0 ? "#c0392b" : "#333"};">${euros(v.restant)}</td></tr>`).join("");

  return `
    <h2>Rapport financier — ${periodLabel}</h2>
    <p style="color:#888;">${esc(orgName)}</p>
    <table style="border-collapse:collapse;max-width:600px;margin-bottom:16px;">
      <tr><td style="${cell}">Loyers appelés</td><td style="${cell}text-align:right;"><b>${euros(dueTotal)}</b></td></tr>
      <tr><td style="${cell}">dont encaissés</td><td style="${cell}text-align:right;">${euros(dueCollected)}</td></tr>
      <tr><td style="${cell}">Restant dû sur le mois</td><td style="${cell}text-align:right;">${euros(dueTotal - dueCollected)}</td></tr>
      <tr><td style="${cell}">Taux de recouvrement</td><td style="${cell}text-align:right;">${recovery === null ? "—" : recovery + " %"}</td></tr>
      <tr><td style="${cell}">Encaissements reçus dans le mois (toutes échéances)</td><td style="${cell}text-align:right;">${euros(sum(received))}</td></tr>
      <tr><td style="${cell}">Impayés à ce jour (toutes périodes)</td><td style="${cell}text-align:right;color:#c0392b;"><b>${euros(sum(overdue))}</b> (${overdue.length})</td></tr>
    </table>
    <table style="border-collapse:collapse;width:100%;max-width:600px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:6px 12px;text-align:left;">Bien</th><th style="padding:6px 12px;text-align:right;">Appelé</th>
        <th style="padding:6px 12px;text-align:right;">Encaissé</th><th style="padding:6px 12px;text-align:right;">Restant</th>
      </tr></thead>
      <tbody>${rows || "<tr><td colspan='4' style='padding:12px;'>Aucune échéance sur la période.</td></tr>"}</tbody>
    </table>
    <p style="color:#888;font-size:12px;">Le détail complet est disponible dans PropOS, onglet Finance.</p>`;
}

Deno.serve(async (req) => {
  if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });

  try {
    const today = parisDate();
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10); // 1er du mois précédent
    const end = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);   // 1er du mois en cours
    const periodLabel = new Date(Date.UTC(y, m - 2, 15)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

    const [{ data: orgs, error: e1 }, { data: dirs, error: e2 }] = await Promise.all([
      supabase.from("organizations").select("id, name"),
      supabase.from("profiles").select("organization_id, email").eq("role", "direction").not("email", "is", null),
    ]);
    if (e1 || e2) throw new Error((e1 ?? e2)!.message);

    const sent: string[] = [];
    for (const org of orgs ?? []) {
      try {
        const recipients = (dirs ?? []).filter((d) => d.organization_id === org.id).map((d) => d.email);
        if (!recipients.length) continue;
        const q = () => supabase.from("payments").select(SELECT).eq("organization_id", org.id);
        const due = await fetchAll<P>((f, t) => q().gte("due_date", start).lt("due_date", end).range(f, t));
        const received = await fetchAll<P>((f, t) => q().eq("status", "paye").gte("paid_date", start).lt("paid_date", end).range(f, t));
        const overdue = await fetchAll<P>((f, t) => q().neq("status", "paye").lt("due_date", today).range(f, t));
        if (!due.length && !received.length && !overdue.length) continue; // agence sans activité financière
        await sendEmail(recipients, `📊 Rapport financier — ${periodLabel}`, buildReport(org.name, periodLabel, due, received, overdue), org.name);
        sent.push(org.id);
      } catch (orgError) {
        // Une agence en échec ne doit pas empêcher les rapports des autres
        await alertCritical(orgError, { organization_id: org.id });
      }
    }

    return new Response(JSON.stringify({ period: periodLabel, organizations: orgs?.length ?? 0, reports_sent: sent.length }),
      { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    await alertCritical(error);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
