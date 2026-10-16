import { describe, it, expect } from "vitest";
import { matchEmployeeToFile } from "../lib/payslips.js";
import { PERMISSIONS } from "../lib/config.js";

describe("rattachement des bulletins PDF", () => {
  const employees = [
    { full_name: "Jean Dupont" }, { full_name: "Marie-Hélène Martin" },
    { full_name: "Jean Martin" }, { full_name: "Anne Dupont" },
  ];
  it.each([
    ["dupont_jean_2026-09.pdf", "Jean Dupont"],
    ["Fiche Marie-Helene MARTIN sept.pdf", "Marie-Hélène Martin"],
    ["DUPONT Anne 09-2026.PDF", "Anne Dupont"],
  ])("%s → %s", (file, expected) => {
    expect(matchEmployeeToFile(file, employees)?.full_name).toBe(expected);
  });
  it.each(["a.pdf", ".pdf", "Jean.pdf", "martin.pdf", "jean_martin_dupont.pdf"])(
    "%s → à vérifier (jamais deviné)", (file) => {
      expect(matchEmployeeToFile(file, employees)).toBeNull();
    });
});

describe("permissions par rôle", () => {
  it("la Maintenance ne voit ni la finance, ni les locataires, ni les RH", () => {
    expect(PERMISSIONS.maintenance).not.toContain("finance");
    expect(PERMISSIONS.maintenance).not.toContain("tenants");
    expect(PERMISSIONS.maintenance).not.toContain("hr");
  });
  it("seule la Direction accède aux RH et à l'abonnement", () => {
    for (const [role, tabs] of Object.entries(PERMISSIONS)) {
      expect(tabs.includes("hr")).toBe(role === "direction");
      expect(tabs.includes("billing")).toBe(role === "direction");
    }
  });
});
