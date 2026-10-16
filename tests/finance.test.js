import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { computeMonthlyFinance, isOverdue, availableMonths, monthLabel, paymentStatusLabel } from "../lib/finance.js";

// Date de référence fixe : 8 octobre 2026
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0)); });
afterAll(() => vi.useRealTimers());

const payments = [
  { id: 1, amount: 1000, due_date: "2026-09-05", status: "paye", paid_date: "2026-09-06" },  // payé à temps
  { id: 2, amount: 2000, due_date: "2026-09-05", status: "en_attente" },                     // jamais payé, statut pas mis à jour
  { id: 3, amount: 1500, due_date: "2026-09-20", status: "paye", paid_date: "2026-10-02" },  // payé en retard le mois suivant
  { id: 4, amount: 3000, due_date: "2026-10-01", status: "paye", paid_date: "2026-10-08" },  // ce mois, échu, payé
  { id: 5, amount: 4000, due_date: "2026-10-28", status: "en_attente" },                     // ce mois, pas encore dû
];

describe("retards", () => {
  it("un loyer non payé dont l'échéance est dépassée est en retard, même si son statut n'a pas été mis à jour", () => {
    expect(isOverdue(payments[1])).toBe(true);
    expect(paymentStatusLabel(payments[1])).toBe("En retard");
  });
  it("un loyer pas encore dû n'est pas en retard", () => {
    expect(isOverdue(payments[4])).toBe(false);
    expect(paymentStatusLabel(payments[4])).toBe("À venir");
  });
  it("un loyer payé n'est jamais en retard", () => {
    expect(isOverdue({ ...payments[2], status: "paye" })).toBe(false);
  });
});

describe("indicateurs du mois", () => {
  it("septembre : appelé, encaissé sur les échéances, reçu dans le mois, recouvrement", () => {
    const f = computeMonthlyFinance(payments, "2026-09");
    expect(f.dueTotal).toBe(4500);
    expect(f.dueCollected).toBe(2500);
    expect(f.receivedTotal).toBe(1000);       // les 1 500 € payés en octobre comptent en octobre
    expect(f.recoveryRate).toBe(56);
  });
  it("octobre : un loyer pas encore dû ne fait pas baisser le recouvrement", () => {
    const f = computeMonthlyFinance(payments, "2026-10");
    expect(f.dueTotal).toBe(7000);
    expect(f.receivedTotal).toBe(4500);
    expect(f.recoveryRate).toBe(100);
  });
  it("les impayés à ce jour couvrent toutes les périodes", () => {
    const f = computeMonthlyFinance(payments, "2026-10");
    expect(f.overdueTotal).toBe(2000);
    expect(f.overdue.map(p => p.id)).toEqual([2]);
  });
  it("« tous les mois » additionne toute la période", () => {
    const f = computeMonthlyFinance(payments, "all");
    expect(f.dueTotal).toBe(11500);
    expect(f.receivedTotal).toBe(5500);
  });
  it("pas d'échéance échue : recouvrement non calculable (et non 0 %)", () => {
    expect(computeMonthlyFinance([payments[4]], "2026-10").recoveryRate).toBeNull();
  });
});

describe("périodes proposées", () => {
  it("mois en cours inclus, du plus récent au plus ancien, sans doublon", () => {
    expect(availableMonths(payments)).toEqual(["2026-10", "2026-09"]);
    expect(availableMonths([])).toEqual(["2026-10"]);
  });
  it("libellés en français", () => {
    expect(monthLabel("2026-09")).toBe("Septembre 2026");
    expect(monthLabel("all")).toBe("Tous les mois");
  });
});
