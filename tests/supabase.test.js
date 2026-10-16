import { describe, it, expect, vi, afterEach } from "vitest";
import { query, authErrorMessage, signUp, readAuthRedirect, ACCOUNT_EXISTS_MSG } from "../lib/supabase.js";

afterEach(() => vi.unstubAllGlobals());

// Faux PostgREST plafonné à 1000 lignes par réponse
function fakePostgrest(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
  const urls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    urls.push(url);
    const [from, to] = opts.headers.Range.split("-").map(Number);
    const page = rows.slice(from, Math.min(to + 1, from + 1000));
    return { ok: true, status: 206, json: async () => page };
  }));
  return urls;
}

describe("lecture paginée (plus de troncature à 1000 lignes)", () => {
  it("lit toutes les lignes, sans doublon", async () => {
    const urls = fakePostgrest(2500);
    const rows = await query("payments", "jeton", "?select=*&order=due_date.desc");
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map(r => r.id)).size).toBe(2500);
    expect(urls).toHaveLength(3);
  });
  it("exactement 1000 lignes : une page vide termine la lecture", async () => {
    fakePostgrest(1000);
    expect(await query("payments", "jeton", "?select=*")).toHaveLength(1000);
  });
  it("ajoute un tri stable par id (sinon les pages peuvent se chevaucher)", async () => {
    const urls = fakePostgrest(3);
    await query("payments", "jeton", "?select=*&order=due_date.desc");
    await query("tenants", "jeton", "?select=*");
    await query("organizations", "jeton");
    expect(urls[0]).toMatch(/payments\?select=\*&order=due_date\.desc,id\.asc$/);
    expect(urls[1]).toMatch(/tenants\?select=\*&order=id\.asc$/);
    expect(urls[2]).toMatch(/organizations\?order=id\.asc$/);
  });
  it("une erreur de lecture est remontée, pas ignorée", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(query("payments", "jeton")).rejects.toThrow("Erreur lecture payments");
  });
});

describe("messages d'erreur de connexion en français", () => {
  it.each([
    [{ error_code: "invalid_credentials" }, "Email ou mot de passe incorrect."],
    [{ msg: "Email not confirmed" }, "Adresse email non confirmée"],
    [{ error_code: "user_already_exists" }, ACCOUNT_EXISTS_MSG],
    [{ error_code: "weak_password" }, "Mot de passe trop faible"],
    [{ error_code: "over_email_send_rate_limit" }, "Trop de tentatives"],
    [{ error_code: "same_password" }, "différent de l'ancien"],
  ])("%j", (data, attendu) => {
    expect(authErrorMessage(data, "défaut")).toContain(attendu);
  });
  it("message inconnu : repli sur le texte d'origine puis sur le défaut", () => {
    expect(authErrorMessage({ msg: "Autre chose" }, "défaut")).toBe("Autre chose");
    expect(authErrorMessage({}, "défaut")).toBe("défaut");
  });
});

describe("inscription", () => {
  it("adresse déjà inscrite (Supabase répond sans erreur mais sans identité) : message clair", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "u1", identities: [] }) })));
    await expect(signUp("deja@example.com", "MotDePasse1")).rejects.toThrow(ACCOUNT_EXISTS_MSG);
  });
  it("nouvelle adresse : inscription acceptée", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "u2", identities: [{ id: "i" }] }) })));
    await expect(signUp("nouveau@example.com", "MotDePasse1")).resolves.toMatchObject({ id: "u2" });
  });
});

describe("retour des liens envoyés par email", () => {
  const run = (hash, search = "") => {
    const hist = { replaceState: vi.fn() };
    const result = readAuthRedirect({ hash, search, pathname: "/" }, hist);
    return { result, cleaned: hist.replaceState.mock.calls.length > 0 };
  };
  it("lien « mot de passe oublié »", () => {
    const { result, cleaned } = run("#access_token=abc&type=recovery");
    expect(result).toEqual({ type: "recovery", access_token: "abc" });
    expect(cleaned).toBe(true); // le jeton ne reste pas dans la barre d'adresse
  });
  it("lien d'invitation", () => {
    expect(run("#access_token=xyz&type=invite").result.type).toBe("invite");
  });
  it("lien expiré", () => {
    expect(run("#error=access_denied&error_code=otp_expired").result.error).toMatch(/expiré/);
  });
  it("adresse normale : rien à faire", () => {
    expect(run("", "").result).toBeNull();
  });
});
