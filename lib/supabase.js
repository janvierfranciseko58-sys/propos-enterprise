import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// ----- Client Supabase minimal (fetch direct vers PostgREST) -----
export const ACCOUNT_EXISTS_MSG = "Un compte existe déjà avec cette adresse email : utilise « J'ai déjà un compte » pour te connecter.";
// Traduction des messages d'erreur Supabase Auth les plus courants
export function authErrorMessage(data, fallback) {
  const code = data.error_code || data.code || "";
  const msg = data.error_description || data.msg || data.message || "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "Email ou mot de passe incorrect.";
  if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) return "Adresse email non confirmée : clique sur le lien reçu par email, puis reconnecte-toi.";
  if (code === "user_already_exists" || /already registered/i.test(msg)) return ACCOUNT_EXISTS_MSG;
  if (code === "weak_password" || (/password/i.test(msg) && /(characters|least|weak)/i.test(msg))) return "Mot de passe trop faible : au moins 8 caractères, avec une minuscule, une majuscule et un chiffre.";
  if (code === "over_email_send_rate_limit" || /rate limit/i.test(msg)) return "Trop de tentatives : réessaie dans quelques minutes.";
  if (code === "same_password" || /different from the old/i.test(msg)) return "Le nouveau mot de passe doit être différent de l'ancien.";
  if (code === "session_not_found" || code === "bad_jwt" || (/jwt|session/i.test(msg) && /expired|invalid|not found/i.test(msg))) return "Ce lien a expiré : redemande un email de réinitialisation.";
  if (/valid email|invalid format/i.test(msg)) return "Adresse email invalide.";
  return msg || fallback;
}
export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(authErrorMessage(data, "Identifiants invalides"));
  return data;
}
export async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(authErrorMessage(data, "Impossible de créer le compte"));
  // Avec la confirmation d'email activée, Supabase ne renvoie pas d'erreur pour une
  // adresse déjà inscrite : il renvoie un utilisateur sans identité.
  const user = data.user || data;
  if (!data.access_token && Array.isArray(user.identities) && user.identities.length === 0) throw new Error(ACCOUNT_EXISTS_MSG);
  return data;
}
// Envoi de l'email de réinitialisation ; le lien ramène sur cette même adresse
export async function requestPasswordReset(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(window.location.origin)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch (_) {}
    throw new Error(authErrorMessage(data, "Impossible d'envoyer l'email pour le moment."));
  }
}
export async function updatePassword(token, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authErrorMessage(data, "Impossible de modifier le mot de passe."));
  return data;
}
// Lit (puis efface de l'adresse) les paramètres ajoutés par Supabase au retour d'un lien email
export function readAuthRedirect(loc = window.location, hist = window.history) {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const search = new URLSearchParams(loc.search);
  for (const [k, v] of search) if (!params.has(k) && (k.startsWith("error") || k === "type")) params.set(k, v);
  if (!params.has("access_token") && !params.has("error") && !params.has("error_code")) return null;
  hist.replaceState(null, "", loc.pathname);
  if (params.get("error") || params.get("error_code")) {
    return {
      error: params.get("error_code") === "otp_expired"
        ? "Ce lien a expiré ou a déjà été utilisé. Redemande-en un nouveau."
        : (params.get("error_description") || "Lien invalide.").replace(/\+/g, " "),
    };
  }
  return { type: params.get("type"), access_token: params.get("access_token") };
}
export async function refreshSession(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Session expirée");
  return data;
}
// Persistance de la session (même principe que supabase-js)
export const SESSION_KEY = "propos.session";
export function saveSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) }));
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}
export function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
}
// Supabase renvoie au plus 1000 lignes par requête : on lit par pages, dans un ordre
// stable (tri demandé puis id), pour ne jamais tronquer silencieusement les données.
export const PAGE_SIZE = 1000;
export async function query(table, token, params = "") {
  let p = params || "?";
  if (/[?&]order=/.test(p)) p = p.replace(/([?&]order=[^&]*)/, "$1,id.asc");
  else p += (p.endsWith("?") ? "" : "&") + "order=id.asc";
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${p}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Range-Unit": "items", Range: `${from}-${from + PAGE_SIZE - 1}` },
    });
    if (res.status === 416) return rows; // plus rien au-delà de la dernière page
    if (!res.ok) throw new Error(`Erreur lecture ${table}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
// Appel d'une fonction SQL exposée par Supabase ; renvoie [] si elle échoue ou n'existe pas
export async function callRpc(fn, token, body = {}) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (_) { return []; }
}
export async function patchRow(table, id, token, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || j.details || ""; } catch (_) {}
    throw new Error(`Erreur mise à jour ${table}${detail ? ` : ${detail}` : ""}`);
  }
  return res.json();
}
export async function insertRow(table, token, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.message || `Erreur création ${table}`);
  return json;
}
export async function deleteRow(table, id, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Prefer: "return=representation" },
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || j.details || ""; } catch (_) {}
    if (detail.toLowerCase().includes("foreign key") || detail.includes("23503")) {
      throw new Error("Suppression impossible : des enregistrements liés existent encore (paiements, etc.). Utilise plutôt le statut pour clôturer sans perdre l'historique.");
    }
    throw new Error(detail || `Erreur suppression ${table}`);
  }
  try { return await res.json(); } catch (_) { return []; }
}
export async function uploadPhoto(file, token, organizationId, employeeId) {
  const ext = file.name.split(".").pop();
  const path = `${organizationId}/${employeeId}-${Date.now()}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/employee-photos/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": file.type, "x-upsert": "true" },
    body: file,
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || ""; } catch (_) {}
    throw new Error(detail || "Échec de l'envoi de la photo");
  }
  return `${SUPABASE_URL}/storage/v1/object/public/employee-photos/${path}`;
}
export async function uploadDocumentFile(file, path, token) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": file.type, "x-upsert": "true" },
    body: file,
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || ""; } catch (_) {}
    throw new Error(detail || "Échec de l'envoi du document");
  }
  return path;
}
export async function getSignedDocumentUrl(path, token) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/documents/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!res.ok) throw new Error("Impossible de générer le lien de consultation");
  const json = await res.json();
  return `${SUPABASE_URL}/storage/v1${json.signedURL}`;
}
export async function getSignedPayslipUrl(path, token) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/payslips/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!res.ok) throw new Error("Impossible de générer le lien de la fiche de paie");
  const json = await res.json();
  return `${SUPABASE_URL}/storage/v1${json.signedURL}`;
} 
export async function uploadPayslipFile(file, path, token) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/payslips/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": file.type || "application/pdf", "x-upsert": "true" },
      body: file,
    });
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.message || ""; } catch (_) {}
      throw new Error(detail || "Échec de l'envoi du fichier");
    }
    return path;
  }
export async function deleteDocumentFile(path, token) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
}
