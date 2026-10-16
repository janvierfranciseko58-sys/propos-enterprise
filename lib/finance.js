// ----------------------------------------------------------------------------
// Calculs financiers par mois
// ----------------------------------------------------------------------------
export const localISODate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const currentMonthKey = () => localISODate().slice(0, 7);
export const monthKeyOf = date => (date || "").slice(0, 7);
export function monthLabel(key) {
  if (key === "all") return "Tous les mois";
  const [y, m] = key.split("-").map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export const isPaid = p => p.status === "paye";
// En retard = non payé et échéance dépassée (sans dépendre d'une mise à jour du statut en base)
export const isOverdue = (p, today = localISODate()) => !isPaid(p) && (p.status === "en_retard" || (!!p.due_date && p.due_date < today));
export const sumAmounts = list => list.reduce((s, p) => s + Number(p.amount || 0), 0);

export function computeMonthlyFinance(payments, month) {
  const today = localISODate();
  const inMonth = date => month === "all" || monthKeyOf(date) === month;
  const due = payments.filter(p => inMonth(p.due_date));                          // échéances appelées sur la période
  const dueElapsed = due.filter(p => p.due_date && p.due_date <= today);          // échéances déjà arrivées à terme
  const received = payments.filter(p => isPaid(p) && inMonth(p.paid_date || p.due_date)); // encaissements datés de la période
  const overdue = payments.filter(p => isOverdue(p, today));                     // impayés à ce jour, toutes périodes
  const dueTotal = sumAmounts(due);
  const dueCollected = sumAmounts(due.filter(isPaid));
  const elapsedTotal = sumAmounts(dueElapsed);
  return {
    due, received, overdue,
    dueTotal, dueCollected, dueRemaining: dueTotal - dueCollected,
    receivedTotal: sumAmounts(received),
    overdueTotal: sumAmounts(overdue),
    // Recouvrement calculé sur les échéances déjà passées, pour ne pas pénaliser les loyers pas encore dus
    recoveryRate: elapsedTotal ? Math.round((sumAmounts(dueElapsed.filter(isPaid)) / elapsedTotal) * 100) : null,
  };
}
// Mois proposés : mois en cours + mois présents dans les paiements, du plus récent au plus ancien
export function availableMonths(payments) {
  const keys = new Set([currentMonthKey()]);
  for (const p of payments) {
    if (p.due_date) keys.add(monthKeyOf(p.due_date));
    if (p.paid_date) keys.add(monthKeyOf(p.paid_date));
  }
  return [...keys].sort().reverse();
}
export const paymentStatusLabel = p => isPaid(p) ? "Payé" : isOverdue(p) ? "En retard" : "À venir";
