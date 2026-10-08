// PropOS — envoi des bulletins de paie (cron 9h)
// N'envoie QUE les bulletins officiels importés (pdf_path, fournis par le cabinet de paie).
// L'application ne génère plus de bulletin : le détail des cotisations ne doit pas être inventé.
// Appelée par pg_cron via public.call_propos_function() avec l'en-tête x-cron-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const DIRECTION_EMAIL = Deno.env.get("DIRECTION_EMAIL")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");
const FROM_EMAIL = "PropOS <notifications@mypropos.app>";
const FUNCTION_NAME = "send-payslips";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data, error } = await supabase.rpc("verify_cron_secret", { p_secret: secret });
  return !error && data === true;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function getStoredPdfBase64(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("payslips").download(path);
  if (error || !data) {
    console.error("Erreur téléchargement PDF :", error?.message);
    return null;
  }
  return await blobToBase64(data);
}

async function sendPayslipEmail(to: string, employeeName: string, period: string, pdfBase64: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: `Votre bulletin de paie – ${period}`,
      html: `<p>Bonjour ${esc(employeeName)},</p><p>Veuillez trouver ci-joint votre bulletin de paie pour la période <b>${esc(period)}</b>.</p><p>Cordialement,<br>La Direction</p>`,
      attachments: [{ filename: `bulletin-de-paie-${period.replace(/\s+/g, "-")}.pdf`, content: pdfBase64 }],
    }),
  });
  if (!res.ok) console.error("Erreur envoi bulletin :", await res.text());
  return res.ok;
}

async function alertCritical(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toISOString();
  console.error(`[CRITICAL] ${FUNCTION_NAME}:`, errorMessage);
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
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL, to: DIRECTION_EMAIL, subject: `🚨 Échec : ${FUNCTION_NAME}`,
        html: `<h2>Erreur dans ${FUNCTION_NAME}</h2><p><strong>Horodatage :</strong> ${timestamp}</p><p><strong>Erreur :</strong> ${esc(errorMessage)}</p>`,
      }),
    }).catch((e) => console.error("Échec email de secours :", e));
  }
}

Deno.serve(async (req) => {
  if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });

  try {
    const { data: payslips, error } = await supabase
      .from("payslips")
      .select("id, period, pdf_path, employees(full_name, email)")
      .eq("status", "payee")
      .is("emailed_at", null)
      .not("pdf_path", "is", null);
    if (error) throw new Error(error.message);

    let sent = 0;
    const failed: string[] = [];
    for (const p of payslips ?? []) {
      const employee = (p as any).employees;
      if (!employee?.email) continue;
      const pdf = await getStoredPdfBase64(p.pdf_path as string);
      if (!pdf) { failed.push(p.id); continue; }
      const ok = await sendPayslipEmail(employee.email, employee.full_name, p.period, pdf);
      if (ok) {
        await supabase.from("payslips").update({ emailed_at: new Date().toISOString() }).eq("id", p.id);
        sent++;
      } else {
        failed.push(p.id);
      }
    }
    if (failed.length) console.error(`${failed.length} bulletin(s) non envoyé(s) :`, failed);

    return new Response(JSON.stringify({ ok: true, sent, failed: failed.length, checked: payslips?.length ?? 0 }),
      { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    await alertCritical(error);
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), { status: 500 });
  }
});
