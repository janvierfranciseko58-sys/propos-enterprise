import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { SUPABASE_URL, SUPABASE_ANON_KEY, BILLING_ENABLED, roles, PERMISSIONS } from "./lib/config.js";
import { ACCOUNT_EXISTS_MSG, authErrorMessage, signIn, signUp, requestPasswordReset, updatePassword, readAuthRedirect, refreshSession, SESSION_KEY, saveSession, loadSession, PAGE_SIZE, query, callRpc, patchRow, insertRow, deleteRow, uploadPhoto, uploadDocumentFile, getSignedDocumentUrl, getSignedPayslipUrl, uploadPayslipFile, deleteDocumentFile } from "./lib/supabase.js";
import { localISODate, currentMonthKey, monthKeyOf, monthLabel, isPaid, isOverdue, sumAmounts, computeMonthlyFinance, availableMonths, paymentStatusLabel } from "./lib/finance.js";
import { nameTokens, matchEmployeeToFile } from "./lib/payslips.js";

const NAVY = "#1F5566", NAVY_DEEP = "#0E2F3A", GOLD = "#B08D57";
const IVORY = "#EEF2F3", INK = "#172A31", SAGE = "#2E6B57", CORAL = "#B0353F", SAND = "#D7DFE2";
const MUTED = "#5F7177", AMBER = "#A86A0C";

const NAV = [
  { key: "overview", label: "Tableau de bord" },
  { key: "buildings", label: "Immeubles" },
  { key: "portfolio", label: "Portefeuille" },
  { key: "tenants", label: "Baux & Locataires" },
  { key: "finance", label: "Finance" },
  { key: "maintenance", label: "Maintenance" },
  { key: "hr", label: "Ressources Humaines" },
  { key: "billing", label: "Abonnement" },
];
const statusColor = { occupe: SAGE, vacant: GOLD, maintenance: AMBER };
const statusBg = { occupe: "#E3EFEA", vacant: "#F3ECDF", maintenance: "#F8EEDC" };
const statusLabel = { occupe: "Occupé", vacant: "Vacant", maintenance: "Maintenance" };
const ticketCategoryLabel = { plomberie: "Plomberie", electricite: "Électricité", climatisation: "Climatisation", structural: "Structurel", ascenseur: "Ascenseur", autre: "Autre" };
const ticketPriorityLabel = { faible: "Faible", moyen: "Moyenne", eleve: "Élevée", urgent: "Urgente" };
const ticketStatusLabel = { ouvert: "Ouvert", en_cours: "En cours", resolu: "Résolu" };
const ticketStatusColor = { ouvert: CORAL, en_cours: "#A86A0C", resolu: SAGE };
const ticketPriorityColor = { faible: "#5F7177", moyen: "#5F7177", eleve: "#A86A0C", urgent: CORAL };
const leaseStatusLabel = { actif: "Actif", expire: "Expiré", resilie: "Résilié" };
const employeeStatusLabel = { actif: "Actif", conge: "En congé", sorti: "Sorti" };
const leaveStatusLabel = { en_attente: "En attente", approuve: "Approuvé", refuse: "Refusé" };
const label = (map, value) => map[value] || value || "—";
const formatDate = d => d ? new Date(d).toLocaleDateString("fr-FR") : "—";

// ----------------------------------------------------------------------------
// Export Excel / PDF
// ----------------------------------------------------------------------------
// Formatte un nombre avec des espaces classiques (le caractère spécial utilisé
// par toLocaleString("fr-FR") n'est pas supporté par la police par défaut du PDF)
function pdfNum(n) {
  return Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €";
}
// Récapitulatif de salaire (brut / net). Ce n'est PAS un bulletin de paie : le détail
// des cotisations n'est pas connu de l'application, il ne doit donc pas être inventé.
// Le bulletin officiel est le PDF fourni par le cabinet de paie (bouton « Importer des fiches »).
async function buildSalarySummaryPDF(employeeName, period, gross, net, role, department, employerName) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  const deductions = Math.max(0, gross - net);

  doc.setFillColor(10, 38, 71);
  doc.rect(0, 0, 210, 30, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(employerName, 14, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(200, 205, 215);
  doc.text("Récapitulatif de salaire", 14, 22);

  let y = 44;
  const label = (text, x) => { doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(120, 120, 120); doc.text(text, x, y); };
  const value = (text, x) => { doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(30, 30, 30); doc.text(text, x, y); };
  label("EMPLOYEUR", 14); label("SALARIÉ", 120);
  y += 7; value(employerName, 14); value(employeeName, 120);
  const poste = [role, department].filter(Boolean).join(" — ");
  if (poste) { y += 6; doc.setFontSize(9); doc.setTextColor(110, 110, 110); doc.text(poste, 120, y); }
  y += 12; label("PÉRIODE", 14);
  y += 7; value(period, 14);

  y += 10;
  doc.setDrawColor(220, 220, 220);
  doc.line(14, y, 196, y);
  const line = (text, amount, bold) => {
    y += 10;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10.5);
    doc.setTextColor(30, 30, 30);
    doc.text(text, 14, y);
    doc.text(amount, 196, y, { align: "right" });
  };
  line("Salaire brut", pdfNum(gross));
  line("Cotisations et prélèvements salariaux (total)", `- ${pdfNum(deductions)}`);
  y += 6;
  doc.setFillColor(240, 243, 248);
  doc.rect(14, y, 182, 16, "F");
  y -= 1;
  line("Net à payer", pdfNum(net), true);

  y += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text(doc.splitTextToSize(
    "Ce document est un récapitulatif établi à partir des montants brut et net enregistrés. Il ne constitue pas un bulletin de paie : " +
    "le détail des cotisations figure sur le bulletin officiel remis par l'employeur.", 182), 14, y);
  doc.setFontSize(8);
  doc.text(`Document généré le ${new Date().toLocaleDateString("fr-FR")} — ${employerName}`, 14, 285);
  return doc;
}
async function exportExcel(filename, sheetName, rows) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

async function exportPDFTable(title, columns, rows, filename) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(title, 14, 18);
  doc.setFontSize(9);
  doc.setTextColor(130, 130, 130);
  doc.text(`Généré le ${new Date().toLocaleDateString("fr-FR")} — PropOS Enterprise`, 14, 25);
  autoTable(doc, { startY: 32, head: [columns], body: rows, headStyles: { fillColor: [10, 38, 71] }, styles: { fontSize: 8 } });
  doc.save(`${filename}.pdf`);
}

async function exportFinanceReport(fin, month, occupancy, filename) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF();
  const period = monthLabel(month);
  const row = p => [p.leases?.tenants?.full_name || "—", p.leases?.properties?.name || "—", formatDate(p.due_date), pdfNum(p.amount)];

  doc.setFontSize(18);
  doc.text(month === "all" ? "Rapport financier — toutes périodes" : `Rapport financier — ${period}`, 14, 20);
  doc.setFontSize(10);
  doc.setTextColor(130, 130, 130);
  doc.text(`PropOS Enterprise — Généré le ${new Date().toLocaleDateString("fr-FR")}`, 14, 27);

  autoTable(doc, {
    startY: 34,
    head: [["Indicateur", "Valeur"]],
    body: [
      ["Loyers appelés (échéances de la période)", pdfNum(fin.dueTotal)],
      ["dont encaissés", pdfNum(fin.dueCollected)],
      ["Restant dû sur la période", pdfNum(fin.dueRemaining)],
      ["Encaissements reçus pendant la période (toutes échéances)", pdfNum(fin.receivedTotal)],
      ["Taux de recouvrement (échéances arrivées à terme)", fin.recoveryRate === null ? "—" : `${fin.recoveryRate} %`],
      ["Impayés à ce jour (toutes périodes)", `${pdfNum(fin.overdueTotal)} (${fin.overdue.length} échéance(s))`],
      ["Taux d'occupation actuel", `${occupancy.rate} % (${occupancy.occupied} / ${occupancy.total} biens)`],
    ],
    headStyles: { fillColor: [10, 38, 71] },
    styles: { fontSize: 9.5 },
    columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
  });

  const section = (title, head, body, color) => {
    let y = doc.lastAutoTable.finalY + 12;
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    doc.text(title, 14, y);
    autoTable(doc, { startY: y + 4, head: [head], body, headStyles: { fillColor: color }, styles: { fontSize: 9 } });
  };
  if (fin.due.length) {
    section("Échéances de la période", ["Locataire", "Bien", "Échéance", "Montant", "Statut"],
      fin.due.map(p => [...row(p), paymentStatusLabel(p)]), [10, 38, 71]);
  }
  if (fin.overdue.length) {
    section("Impayés à ce jour — détail", ["Locataire", "Bien", "Échéance", "Montant"], fin.overdue.map(row), [196, 102, 79]);
  }
  doc.save(`${filename}.pdf`);
}

function ExportButtons({ onExcel, onPDF }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <span onClick={onExcel} style={{ fontSize: 12, color: SAGE, cursor: "pointer", fontWeight: 600 }}>⬇ Excel</span>
      <span onClick={onPDF} style={{ fontSize: 12, color: CORAL, cursor: "pointer", fontWeight: 600 }}>⬇ PDF</span>
    </div>
  );
}

// ----- UI atoms -----
// Indicateur : une cellule du panneau .grid-kpi (séparateurs fins), chiffre mis en avant.
// La couleur ne sert qu'à signaler un problème (accent CORAL) ; sinon le chiffre reste à l'encre.
function KpiCard({ label, value, sub, accent }) {
  const alert = accent === CORAL;
  return (
    <div className="kpi" style={{ background: "#fff", padding: "20px 22px 18px" }}>
      <div style={{ fontSize: 13, color: MUTED }}>{label}</div>
      <div className="kpi-value" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 29, fontWeight: 600, lineHeight: 1.1, color: alert ? CORAL : INK, marginTop: 10, fontVariantNumeric: "lining-nums tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}
function SectionCard({ title, children, style, action }) {
  return (
    <div className="section-card" style={{ background: "#fff", borderRadius: 12, padding: "22px 24px", border: `1px solid ${SAND}`, ...style }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 18, fontWeight: 600, color: INK, margin: 0, letterSpacing: "-0.01em" }}>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
function BarRow({ label, value, max, color }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5F7177", marginBottom: 4 }}>
        <span>{label}</span><span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{value.toLocaleString("fr-FR")} €</span>
      </div>
      <div style={{ height: 8, background: SAND, borderRadius: 20 }}>
        <div style={{ width: `${pct}%`, height: 8, background: color, borderRadius: 20 }} />
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(14,47,58,0.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 28, width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(14,47,58,0.28)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 18, color: NAVY_DEEP, margin: 0 }}>{title}</h3>
          <span onClick={onClose} style={{ cursor: "pointer", fontSize: 18, color: "#5F7177" }}>✕</span>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 12, color: "#5F7177", display: "block", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
const inputStyle = { width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${SAND}`, background: "#fff", color: INK, fontSize: 13.5, fontFamily: "'Plus Jakarta Sans', sans-serif" };
const primaryBtn = { background: NAVY_DEEP, color: "#fff", border: "none", borderRadius: 8, padding: "11px 0", fontSize: 13.5, fontWeight: 500, cursor: "pointer", width: "100%" };
const addBtn = { background: NAVY_DEEP, color: "#fff", border: "none", borderRadius: 8, padding: "9px 15px", fontSize: 13, fontWeight: 500, cursor: "pointer" };

function AddPropertyForm({ buildings, onSubmit, submitting }) {
  const [f, setF] = useState({ building_id: "", reference: "", name: "", address: "", surface: "", pieces: "", rent: "", charges: "0", status: "vacant" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Immeuble (optionnel)">
        <select style={inputStyle} value={f.building_id} onChange={set("building_id")}>
          <option value="">— Aucun / bien isolé —</option>
          {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Référence (ex: A-101)"><input style={inputStyle} value={f.reference} onChange={set("reference")} /></Field>
      <Field label="Nom du bien"><input style={inputStyle} value={f.name} onChange={set("name")} placeholder="T3 Rénové" /></Field>
      <Field label="Adresse"><input style={inputStyle} value={f.address} onChange={set("address")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Surface (m²)"><input style={inputStyle} type="number" value={f.surface} onChange={set("surface")} /></Field>
        <Field label="Pièces"><input style={inputStyle} type="number" value={f.pieces} onChange={set("pieces")} /></Field>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Loyer (€)"><input style={inputStyle} type="number" value={f.rent} onChange={set("rent")} /></Field>
        <Field label="Charges (€)"><input style={inputStyle} type="number" value={f.charges} onChange={set("charges")} /></Field>
      </div>
      <Field label="Statut">
        <select style={inputStyle} value={f.status} onChange={set("status")}>
          <option value="vacant">Vacant</option>
          <option value="occupe">Occupé</option>
          <option value="maintenance">Maintenance</option>
        </select>
      </Field>
      <button style={primaryBtn} disabled={submitting || !f.name || !f.address || !f.rent}
        onClick={() => onSubmit({ ...f, building_id: f.building_id || null, surface: Number(f.surface) || null, pieces: Number(f.pieces) || null, rent: Number(f.rent), charges: Number(f.charges) || 0 })}>
        {submitting ? "Création…" : "Ajouter le bien"}
      </button>
    </div>
  );
}

function AddTenantForm({ onSubmit, submitting }) {
  const [f, setF] = useState({ full_name: "", email: "", phone: "" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Nom complet"><input style={inputStyle} value={f.full_name} onChange={set("full_name")} /></Field>
      <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} /></Field>
      <Field label="Téléphone"><input style={inputStyle} value={f.phone} onChange={set("phone")} /></Field>
      <button style={primaryBtn} disabled={submitting || !f.full_name} onClick={() => onSubmit(f)}>
        {submitting ? "Création…" : "Ajouter le locataire"}
      </button>
    </div>
  );
}

function AddLeaseForm({ properties, tenants, onSubmit, submitting }) {
  const [f, setF] = useState({ property_id: "", tenant_id: "", rent: "", start_date: "", end_date: "" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Bien">
        <select style={inputStyle} value={f.property_id} onChange={set("property_id")}>
          <option value="">— Choisir un bien —</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name} — {p.address}</option>)}
        </select>
      </Field>
      <Field label="Locataire">
        <select style={inputStyle} value={f.tenant_id} onChange={set("tenant_id")}>
          <option value="">— Choisir un locataire —</option>
          {tenants.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
        </select>
      </Field>
      <Field label="Loyer (€)"><input style={inputStyle} type="number" value={f.rent} onChange={set("rent")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Début"><input style={inputStyle} type="date" value={f.start_date} onChange={set("start_date")} /></Field>
        <Field label="Fin (optionnel)"><input style={inputStyle} type="date" value={f.end_date} onChange={set("end_date")} /></Field>
      </div>
      <button style={primaryBtn} disabled={submitting || !f.property_id || !f.tenant_id || !f.rent || !f.start_date}
        onClick={() => onSubmit({ ...f, rent: Number(f.rent), end_date: f.end_date || null })}>
        {submitting ? "Création…" : "Créer le bail"}
      </button>
    </div>
  );
}

function EditPropertyForm({ property, buildings, onSubmit, onDelete, submitting }) {
  const [f, setF] = useState({
    building_id: property.building_id || "",
    reference: property.reference || "", name: property.name || "", address: property.address || "",
    surface: property.surface || "", pieces: property.pieces || "", rent: property.rent || "",
    charges: property.charges || "0", status: property.status || "vacant",
  });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Immeuble (optionnel)">
        <select style={inputStyle} value={f.building_id} onChange={set("building_id")}>
          <option value="">— Aucun / bien isolé —</option>
          {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Référence"><input style={inputStyle} value={f.reference} onChange={set("reference")} /></Field>
      <Field label="Nom du bien"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
      <Field label="Adresse"><input style={inputStyle} value={f.address} onChange={set("address")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Surface (m²)"><input style={inputStyle} type="number" value={f.surface} onChange={set("surface")} /></Field>
        <Field label="Pièces"><input style={inputStyle} type="number" value={f.pieces} onChange={set("pieces")} /></Field>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Loyer (€)"><input style={inputStyle} type="number" value={f.rent} onChange={set("rent")} /></Field>
        <Field label="Charges (€)"><input style={inputStyle} type="number" value={f.charges} onChange={set("charges")} /></Field>
      </div>
      <Field label="Statut">
        <select style={inputStyle} value={f.status} onChange={set("status")}>
          <option value="vacant">Vacant</option>
          <option value="occupe">Occupé</option>
          <option value="maintenance">Maintenance</option>
        </select>
      </Field>
      <button style={primaryBtn} disabled={submitting}
        onClick={() => onSubmit({ ...f, building_id: f.building_id || null, surface: Number(f.surface) || null, pieces: Number(f.pieces) || null, rent: Number(f.rent), charges: Number(f.charges) || 0 })}>
        {submitting ? "Enregistrement…" : "Enregistrer les modifications"}
      </button>
      <button
        style={{ ...primaryBtn, background: "#fff", color: CORAL, border: `1px solid ${CORAL}55`, marginTop: 10 }}
        disabled={submitting}
        onClick={() => { if (confirm(`Supprimer définitivement "${property.name}" ?`)) onDelete(); }}>
        Supprimer le bien
      </button>
    </div>
  );
}

function EditTenantForm({ tenant, onSubmit, onDelete, submitting, documents, onUploadDoc, onViewDoc, onDeleteDoc, uploadingDoc }) {
  const [f, setF] = useState({ full_name: tenant.full_name || "", email: tenant.email || "", phone: tenant.phone || "" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Nom complet"><input style={inputStyle} value={f.full_name} onChange={set("full_name")} /></Field>
      <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} /></Field>
      <Field label="Téléphone"><input style={inputStyle} value={f.phone} onChange={set("phone")} /></Field>
      <button style={primaryBtn} disabled={submitting || !f.full_name} onClick={() => onSubmit(f)}>
        {submitting ? "Enregistrement…" : "Enregistrer les modifications"}
      </button>
      <button
        style={{ ...primaryBtn, background: "#fff", color: CORAL, border: `1px solid ${CORAL}55`, marginTop: 10 }}
        disabled={submitting}
        onClick={() => { if (confirm(`Supprimer le locataire "${tenant.full_name}" ? Impossible si un bail actif y est encore rattaché.`)) onDelete(); }}>
        Supprimer le locataire
      </button>
      <DocumentsPanel documents={documents} uploading={uploadingDoc}
        onUpload={(file, docType) => onUploadDoc(file, docType, "tenant", tenant.id)}
        onView={onViewDoc} onDelete={onDeleteDoc} />
    </div>
  );
}

function EditLeaseForm({ lease, properties, onSubmit, onDelete, submitting, documents, onUploadDoc, onViewDoc, onDeleteDoc, uploadingDoc }) {
  const [f, setF] = useState({
    property_id: lease.property_id || "", rent: lease.rent || "",
    start_date: lease.start_date || "", end_date: lease.end_date || "", status: lease.status || "actif",
  });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Bien">
        <select style={inputStyle} value={f.property_id} onChange={set("property_id")}>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name} — {p.address}</option>)}
        </select>
      </Field>
      <Field label="Loyer (€)"><input style={inputStyle} type="number" value={f.rent} onChange={set("rent")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Début"><input style={inputStyle} type="date" value={f.start_date} onChange={set("start_date")} /></Field>
        <Field label="Fin (optionnel)"><input style={inputStyle} type="date" value={f.end_date || ""} onChange={set("end_date")} /></Field>
      </div>
      <Field label="Statut">
        <select style={inputStyle} value={f.status} onChange={set("status")}>
          <option value="actif">Actif</option>
          <option value="expire">Expiré</option>
          <option value="resilie">Résilié</option>
        </select>
      </Field>
      <button style={primaryBtn} disabled={submitting}
        onClick={() => onSubmit({ ...f, rent: Number(f.rent), end_date: f.end_date || null })}>
        {submitting ? "Enregistrement…" : "Enregistrer les modifications"}
      </button>
      <button
        style={{ ...primaryBtn, background: "#fff", color: CORAL, border: `1px solid ${CORAL}55`, marginTop: 10 }}
        disabled={submitting}
        onClick={() => { if (confirm("Supprimer définitivement ce bail ? Impossible si des paiements y sont rattachés — utilise plutôt le statut \"Résilié\" ci-dessus dans ce cas.")) onDelete(); }}>
        Supprimer le bail (définitif)
      </button>
      <div style={{ fontSize: 12, color: "#5F7177", marginTop: 8, lineHeight: 1.4 }}>
        Pour clôturer un bail normalement, change son statut en "Résilié" et enregistre — l'historique des paiements reste conservé.
      </div>
      <DocumentsPanel documents={documents} uploading={uploadingDoc}
        onUpload={(file, docType) => onUploadDoc(file, docType, "lease", lease.id)}
        onView={onViewDoc} onDelete={onDeleteDoc} />
    </div>
  );
}

function AddBuildingForm({ onSubmit, submitting }) {
  const [f, setF] = useState({ name: "", address: "", description: "" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Nom de l'immeuble"><input style={inputStyle} value={f.name} onChange={set("name")} placeholder="Tour Odéon" /></Field>
      <Field label="Adresse"><input style={inputStyle} value={f.address} onChange={set("address")} /></Field>
      <Field label="Description (optionnel)">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} value={f.description} onChange={set("description")} />
      </Field>
      <button style={primaryBtn} disabled={submitting || !f.name || !f.address} onClick={() => onSubmit(f)}>
        {submitting ? "Création…" : "Ajouter l'immeuble"}
      </button>
    </div>
  );
}

function EditBuildingForm({ building, onSubmit, onDelete, submitting }) {
  const [f, setF] = useState({ name: building.name || "", address: building.address || "", description: building.description || "" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <Field label="Nom de l'immeuble"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
      <Field label="Adresse"><input style={inputStyle} value={f.address} onChange={set("address")} /></Field>
      <Field label="Description (optionnel)">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} value={f.description} onChange={set("description")} />
      </Field>
      <button style={primaryBtn} disabled={submitting || !f.name} onClick={() => onSubmit(f)}>
        {submitting ? "Enregistrement…" : "Enregistrer les modifications"}
      </button>
      <button
        style={{ ...primaryBtn, background: "#fff", color: CORAL, border: `1px solid ${CORAL}55`, marginTop: 10 }}
        disabled={submitting}
        onClick={() => { if (confirm(`Supprimer l'immeuble "${building.name}" ? Impossible si des biens y sont encore rattachés.`)) onDelete(); }}>
        Supprimer l'immeuble
      </button>
    </div>
  );
}

function InviteStaffForm({ onSubmit, submitting }) {
  const [f, setF] = useState({ email: "", full_name: "", role: "finance" });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 14, lineHeight: 1.5 }}>
        La personne invitée pourra créer son accès depuis « Espace Équipe », lien « Première connexion ? Créer mon accès » avec cette adresse email.
      </div>
      <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} placeholder="prenom.nom@exemple.com" /></Field>
      <Field label="Nom complet"><input style={inputStyle} value={f.full_name} onChange={set("full_name")} placeholder="Prénom Nom" /></Field>
      <Field label="Rôle">
        <select style={inputStyle} value={f.role} onChange={set("role")}>
          {Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      <button style={primaryBtn} disabled={submitting || !f.email || !f.full_name} onClick={() => onSubmit(f)}>
        {submitting ? "Envoi…" : "Envoyer l'invitation"}
      </button>
    </div>
  );
}

function PhotoAvatar({ url, name, size }) {
  const initials = (name || "?").split(" ").map(n => n[0]).join("").slice(0, 2);
  if (url) {
    return <img src={url} alt={name} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: GOLD, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: size * 0.38, color: NAVY_DEEP, fontWeight: 600 }}>
      {initials}
    </div>
  );
}

function EmployeeCard({ employee, onEdit, onDelete }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
        <PhotoAvatar url={employee.photo_url} name={employee.full_name} size={52} />
        <div>
          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 18, color: NAVY_DEEP }}>{employee.full_name}</div>
          <div style={{ fontSize: 12.5, color: GOLD, fontWeight: 600 }}>{employee.role_title}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Service</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>{employee.department}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Immeuble</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>{employee.buildings?.name || "Siège / Direction"}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Email</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>{employee.email || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Téléphone</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>{employee.phone || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Date d'entrée</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>{employee.hired_date}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F7177" }}>Statut</div>
          <div style={{ fontSize: 13.5, marginTop: 3 }}>
            <span style={{
              fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
              background: employee.status === "actif" ? "#E3EFEA" : "#F8EEDC",
              color: employee.status === "actif" ? SAGE : "#A86A0C"
            }}>{label(employeeStatusLabel, employee.status)}</span>
          </div>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${SAND}`, marginTop: 14, paddingTop: 14, marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: "#5F7177" }}>Salaire brut mensuel</div>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 20, fontWeight: 600, color: NAVY_DEEP, marginTop: 4 }}>
          {Number(employee.monthly_gross_salary).toLocaleString("fr-FR")} €
        </div>
      </div>
      <button style={primaryBtn} onClick={onEdit}>Modifier la fiche</button>
      <button
        style={{ ...primaryBtn, background: "#fff", color: CORAL, border: `1px solid ${CORAL}55`, marginTop: 10 }}
        onClick={() => { if (confirm(`Supprimer définitivement "${employee.full_name}" ?`)) onDelete(); }}>
        Supprimer l'employé
      </button>
    </div>
  );
}

const docTypeLabels = { contrat: "Contrat de bail", etat_des_lieux: "État des lieux", piece_identite: "Pièce d'identité", autre: "Autre" };

function DocumentsPanel({ documents, onUpload, onView, onDelete, uploading }) {
  const [docType, setDocType] = useState("contrat");
  return (
    <div style={{ borderTop: `1px solid ${SAND}`, marginTop: 16, paddingTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: NAVY_DEEP, marginBottom: 10 }}>Documents</div>

      {documents.length === 0 && <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 10 }}>Aucun document pour l'instant.</div>}

      {documents.map(d => (
        <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #E8EDEF" }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{d.name}</div>
            <div style={{ fontSize: 12, color: "#5F7177" }}>{docTypeLabels[d.doc_type] || d.doc_type}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span onClick={() => onView(d)} style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", fontWeight: 500 }}>Voir</span>
            <span onClick={() => onDelete(d)} style={{ fontSize: 12.5, color: CORAL, cursor: "pointer", fontWeight: 500 }}>Supprimer</span>
          </div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <select style={{ ...inputStyle, flex: "0 0 150px" }} value={docType} onChange={e => setDocType(e.target.value)}>
          <option value="contrat">Contrat de bail</option>
          <option value="etat_des_lieux">État des lieux</option>
          <option value="piece_identite">Pièce d'identité</option>
          <option value="autre">Autre</option>
        </select>
        <label style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", border: `1px solid ${SAND}`, borderRadius: 4, padding: "9px 12px", flex: 1, textAlign: "center" }}>
          {uploading ? "Envoi…" : "+ Ajouter un fichier"}
          <input type="file" style={{ display: "none" }} disabled={uploading}
            onChange={e => e.target.files[0] && onUpload(e.target.files[0], docType)} />
        </label>
      </div>
    </div>
  );
}

function PhotoUploadField({ currentUrl, onFileSelected, uploading }) {
  return (
    <Field label="Photo (optionnel)">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PhotoAvatar url={currentUrl} name="?" size={44} />
        <label style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", border: `1px solid ${SAND}`, borderRadius: 4, padding: "8px 12px" }}>
          {uploading ? "Envoi…" : "Choisir une photo"}
          <input type="file" accept="image/*" style={{ display: "none" }} disabled={uploading}
            onChange={e => e.target.files[0] && onFileSelected(e.target.files[0])} />
        </label>
      </div>
    </Field>
  );
}

function EmployeeForm({ initial, buildings, onSubmit, submitting, onUploadPhoto, uploadingPhoto }) {
  const [f, setF] = useState({
    building_id: initial?.building_id || "", full_name: initial?.full_name || "",
    role_title: initial?.role_title || "", department: initial?.department || "",
    email: initial?.email || "", phone: initial?.phone || "",
    hired_date: initial?.hired_date || "", monthly_gross_salary: initial?.monthly_gross_salary || "",
    status: initial?.status || "actif", photo_url: initial?.photo_url || "",
  });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <PhotoUploadField currentUrl={f.photo_url} uploading={uploadingPhoto}
        onFileSelected={async file => { const url = await onUploadPhoto(file); if (url) setF(prev => ({ ...prev, photo_url: url })); }} />
      <Field label="Immeuble (optionnel, laisser vide pour Siège/Direction)">
        <select style={inputStyle} value={f.building_id} onChange={set("building_id")}>
          <option value="">— Siège / Direction —</option>
          {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Nom complet"><input style={inputStyle} value={f.full_name} onChange={set("full_name")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Poste"><input style={inputStyle} value={f.role_title} onChange={set("role_title")} placeholder="Concierge" /></Field>
        <Field label="Service"><input style={inputStyle} value={f.department} onChange={set("department")} placeholder="Conciergerie" /></Field>
      </div>
      <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} /></Field>
      <Field label="Téléphone"><input style={inputStyle} value={f.phone} onChange={set("phone")} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Date d'entrée"><input style={inputStyle} type="date" value={f.hired_date} onChange={set("hired_date")} /></Field>
        <Field label="Salaire brut (€)"><input style={inputStyle} type="number" value={f.monthly_gross_salary} onChange={set("monthly_gross_salary")} /></Field>
      </div>
      <Field label="Statut">
        <select style={inputStyle} value={f.status} onChange={set("status")}>
          <option value="actif">Actif</option>
          <option value="conge">En congé</option>
          <option value="sorti">Sorti</option>
        </select>
      </Field>
      <button style={primaryBtn} disabled={submitting || !f.full_name || !f.role_title}
        onClick={() => onSubmit({ ...f, building_id: f.building_id || null, monthly_gross_salary: Number(f.monthly_gross_salary) || 0, photo_url: f.photo_url || null })}>
        {submitting ? "Enregistrement…" : (initial ? "Enregistrer les modifications" : "Ajouter l'employé")}
      </button>
    </div>
  );
}

 function BulkPayslipImport({ payslips, employees, session, onDone }) {
  const periods = [...new Set(payslips.map(p => p.period))];
  const [period, setPeriod] = useState(periods[0] || "");
  const [items, setItems] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState(null);

  function handleFiles(fileList) {
    const mapped = Array.from(fileList).map(file => ({
      file, employee: matchEmployeeToFile(file.name, employees),
    }));
    setItems(mapped);
    setSummary(null);
  }

  function setEmployeeForItem(idx, employeeId) {
    const emp = employees.find(e => e.id === employeeId) || null;
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, employee: emp } : it));
  }

  async function confirmImport() {
    setUploading(true);
    let done = 0, skipped = 0; const errors = [];
    for (const it of items) {
      if (!it.employee) { skipped++; continue; }
      const payslip = payslips.find(p => p.employee_id === it.employee.id && p.period === period);
      if (!payslip) { skipped++; continue; }
      try {
        const ext = (it.file.name.split(".").pop() || "pdf");
        const path = `${payslip.organization_id}/${it.employee.id}-${period.replace(/\s+/g, "_")}.${ext}`;
        await uploadPayslipFile(it.file, path, session.access_token);
        await patchRow("payslips", payslip.id, session.access_token, { pdf_path: path });
        done++;
      } catch (e) { errors.push(`${it.employee.full_name} : ${e.message}`); }
    }
    setUploading(false);
    setSummary({ done, skipped, errors });
    onDone();
  }

  return (
    <div style={{ border: `1px dashed ${SAND}`, borderRadius: 4, padding: 18, marginBottom: 18, background: "#fff" }}>
      <Field label="Période concernée">
        <select style={inputStyle} value={period} onChange={e => setPeriod(e.target.value)}>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
      <label style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", border: `1px solid ${SAND}`, borderRadius: 4, padding: "9px 12px", display: "inline-block" }}>
        Choisir les fichiers PDF…
        <input type="file" accept="application/pdf" multiple style={{ display: "none" }}
          onChange={e => handleFiles(e.target.files)} />
      </label>

      {items.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <table className="leases">
            <thead><tr><th>Fichier</th><th>Employé détecté</th><th></th></tr></thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td style={{ fontSize: 12.5 }}>{it.file.name}</td>
                  <td>
                    <select style={{ ...inputStyle, padding: "5px 8px" }} value={it.employee?.id || ""} onChange={e => setEmployeeForItem(idx, e.target.value)}>
                      <option value="">— Non reconnu —</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                    </select>
                  </td>
                  <td style={{ fontSize: 12, fontWeight: 500, color: it.employee ? SAGE : AMBER }}>{it.employee ? "Reconnu" : "À vérifier"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={{ ...primaryBtn, marginTop: 14, width: "auto", padding: "10px 20px" }} disabled={uploading} onClick={confirmImport}>
            {uploading ? "Import en cours…" : `Importer ${items.length} fichier(s)`}
          </button>
        </div>
      )}

      {summary && (
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          <div style={{ color: SAGE }}>{summary.done} fiche(s) importée(s) avec succès.</div>
          {summary.skipped > 0 && <div style={{ color: CORAL }}>{summary.skipped} fichier(s) ignoré(s) (employé non reconnu ou aucune fiche existante pour cette période).</div>}
          {summary.errors.map((e, i) => <div key={i} style={{ color: CORAL }}>{e}</div>)}
        </div>
      )}
    </div>
  );
}
function PasswordInput({ value, onChange, autoComplete, style }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: "relative", margin: "4px 0 18px", ...style }}>
      <input value={value} onChange={onChange} type={visible ? "text" : "password"} autoComplete={autoComplete}
        style={{ width: "100%", boxSizing: "border-box", padding: "11px 40px 11px 13px", borderRadius: 8, border: `1px solid ${SAND}`, fontSize: 14, color: INK, background: "#fff" }} />
      <span onClick={() => setVisible(v => !v)}
        title={visible ? "Masquer le mot de passe" : "Afficher le mot de passe"}
        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: "#5F7177", display: "flex", lineHeight: 0 }}>
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a18.7 18.7 0 0 1 4.22-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 10 8 10 8a18.6 18.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s3-8 11-8 11 8 11 8-3 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </span>
    </div>
  );
}

const authInputStyle = { width: "100%", padding: "11px 13px", borderRadius: 8, border: `1px solid ${SAND}`, margin: "6px 0 16px", fontSize: 14, color: INK, background: "#fff" };
const authBtnStyle = { width: "100%", background: NAVY_DEEP, color: "#fff", border: "none", borderRadius: 8, padding: "12px 0", fontSize: 14, fontWeight: 500, cursor: "pointer" };
const authLinkStyle = { fontSize: 12, color: NAVY, cursor: "pointer" };
const AuthError = ({ children }) => children ? <div style={{ background: "#F7E4E5", color: CORAL, fontSize: 12.5, padding: "10px 12px", borderRadius: 8, marginBottom: 14, lineHeight: 1.45 }}>{children}</div> : null;
const AuthInfo = ({ children }) => children ? <div style={{ background: "#E3EFEA", color: SAGE, fontSize: 12.5, padding: "10px 12px", borderRadius: 8, marginBottom: 14, lineHeight: 1.45 }}>{children}</div> : null;

// Monogramme : « P » dans un cadre laiton, comme une plaque d'entrée d'immeuble
function Monogram({ size = 36, onDark = false }) {
  return (
    <div aria-hidden="true" style={{ width: size, height: size, borderRadius: 8, border: `1.5px solid ${GOLD}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: onDark ? "rgba(176,141,87,0.08)" : "transparent" }}>
      <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, color: onDark ? "#E2CFA8" : NAVY_DEEP, fontSize: size * 0.52, lineHeight: 1, marginTop: size * 0.04 }}>P</span>
    </div>
  );
}

function AuthCard({ children }) {
  return (
    <div className="auth-layout" style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 1fr)", background: IVORY }}>
      <aside className="auth-panel" style={{ background: NAVY_DEEP, color: "#fff", padding: "48px 56px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Monogram size={38} onDark />
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 18, letterSpacing: "0.01em" }}>PropOS</span>
        </div>
        <div className="auth-statement" style={{ maxWidth: 470 }}>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 38, lineHeight: 1.12, letterSpacing: "-0.015em", margin: 0 }}>
            La gestion de vos résidences, du bail à la conciergerie.
          </h1>
          <p style={{ marginTop: 22, fontSize: 15.5, lineHeight: 1.6, color: "#B9C9CE", maxWidth: 400 }}>
            Loyers, baux, maintenance et équipe réunis en un seul endroit, pour les agences immobilières et leurs locataires.
          </p>
          <div style={{ width: 56, height: 1.5, background: GOLD, marginTop: 30 }} />
        </div>
        <div style={{ fontSize: 12.5, color: "#8FA7AE" }}>mypropos.app</div>
      </aside>
      <main style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div className="auth-card" style={{ width: 400, maxWidth: "100%" }}>
          <div className="auth-brand-mobile" style={{ display: "none", alignItems: "center", gap: 10, marginBottom: 26 }}>
            <Monogram size={34} />
            <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 16, color: INK }}>PropOS</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

// Écran affiché au retour du lien « Réinitialiser le mot de passe »
function ResetPasswordScreen({ token, onDone, welcome }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) return setError("Le mot de passe doit contenir au moins 8 caractères.");
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return setError("Le mot de passe doit contenir au moins une minuscule, une majuscule et un chiffre.");
    if (password !== confirmation) return setError("Les deux mots de passe ne sont pas identiques.");
    setSaving(true);
    try {
      await updatePassword(token, password);
      // On ferme la session ouverte par le lien : la personne se reconnecte normalement
      fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }).catch(() => {});
      onDone(welcome ? "Ton accès est prêt ✓ Connecte-toi avec ton email et ce mot de passe." : "Mot de passe modifié. Connecte-toi avec ton nouveau mot de passe.");
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <AuthCard>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 26, lineHeight: 1.15, color: INK, marginBottom: 10 }}>{welcome ? "Bienvenue sur PropOS" : "Nouveau mot de passe"}</div>
      {welcome && <div style={{ fontSize: 12.5, color: INK, marginBottom: 8, lineHeight: 1.5 }}>Choisis le mot de passe de ton espace.</div>}
      <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 16, lineHeight: 1.5 }}>
        Au moins 8 caractères, avec une minuscule, une majuscule et un chiffre.
      </div>
      <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Nouveau mot de passe</label>
      <PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" style={{ marginBottom: 14 }} />
      <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Confirmer le mot de passe</label>
      <PasswordInput value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" />
      <AuthError>{error}</AuthError>
      <button onClick={submit} disabled={saving || !password || !confirmation} style={authBtnStyle}>
        {saving ? "Enregistrement…" : "Enregistrer le mot de passe"}
      </button>
      <div style={{ textAlign: "center", marginTop: 14 }}>
        <span onClick={() => onDone("")} style={authLinkStyle}>Retour à la connexion</span>
      </div>
    </AuthCard>
  );
}

// ----- Abonnement de l'agence (page réservée à la Direction) -----
const subscriptionLabel = { trialing: "Période d'essai", active: "Abonnement actif", past_due: "Paiement en échec", canceled: "Abonnement résilié" };

async function callBilling(action, token) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/billing`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Le service de paiement est indisponible.");
  return json;
}

function BillingPanel({ session, orgInfo, lots, returnStatus, suspended }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!BILLING_ENABLED) return;
    callBilling("info", session.access_token).then(setInfo).catch(e => setError(e.message));
  }, [session.access_token, returnStatus]);

  async function go(action) {
    setError(""); setBusy(action);
    try {
      const { url } = await callBilling(action, session.access_token);
      window.location.href = url; // page de paiement / espace client Stripe
    } catch (e) { setError(e.message); setBusy(""); }
  }

  const status = info?.status || orgInfo?.subscription_status;
  const statusColor = { active: SAGE, trialing: "#A86A0C", past_due: CORAL, canceled: CORAL }[status] || "#5F7177";
  const euros = cents => cents == null ? "—" : `${(cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: cents % 100 ? 2 : 0 })} €`;
  const row = (label, value) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid #E3E9EB", fontSize: 13.5 }}>
      <span style={{ color: "#5F7177" }}>{label}</span><span style={{ fontWeight: 500, textAlign: "right" }}>{value}</span>
    </div>
  );

  return (
    <SectionCard title="Abonnement" style={{ maxWidth: 640 }}>
      {suspended && (
        <AuthError>L'accès de ton agence est suspendu : abonne-toi pour retrouver toutes tes données, elles sont intactes.</AuthError>
      )}
      {returnStatus === "success" && <AuthInfo>Merci ! Ton abonnement est enregistré. Son activation peut prendre quelques secondes.</AuthInfo>}
      {returnStatus === "cancel" && <AuthInfo>Paiement annulé : rien n'a été débité.</AuthInfo>}

      {row("Statut", <span style={{ color: statusColor }}>{subscriptionLabel[status] || "—"}</span>)}
      {status === "trialing" && (info?.trial_ends_at || orgInfo?.trial_ends_at) && row("Fin de l'essai", formatDate(info?.trial_ends_at || orgInfo?.trial_ends_at))}
      {row("Lots gérés", info?.lots ?? lots)}
      {BILLING_ENABLED && row("Montant mensuel estimé (HT)", euros(info?.estimate_cents))}
      {BILLING_ENABLED && (info?.current_period_end || orgInfo?.current_period_end) && status === "active" && row("Prochaine facture", formatDate(info?.current_period_end || orgInfo?.current_period_end))}

      <div style={{ marginTop: 18 }}>
        {!BILLING_ENABLED ? (
          <div style={{ fontSize: 12.5, color: "#5F7177", lineHeight: 1.55 }}>
            Le paiement en ligne sera bientôt disponible. D'ici là, ton agence utilise PropOS sans limitation.
          </div>
        ) : (
          <>
            <AuthError>{error}</AuthError>
            {info?.has_subscription ? (
              <button style={{ ...authBtnStyle, width: "auto", padding: "10px 20px" }} disabled={!!busy} onClick={() => go("portal")}>
                {busy === "portal" ? "Ouverture…" : "Gérer mon abonnement (factures, carte, résiliation)"}
              </button>
            ) : (
              <button style={{ ...authBtnStyle, width: "auto", padding: "10px 20px" }} disabled={!!busy || !info} onClick={() => go("checkout")}>
                {busy === "checkout" ? "Ouverture…" : "S'abonner"}
              </button>
            )}
            <div style={{ fontSize: 12.5, color: "#5F7177", marginTop: 10, lineHeight: 1.5 }}>
              Facturation mensuelle selon le nombre de lots, ajustée automatiquement chaque nuit. Paiement sécurisé par Stripe.
              {status === "trialing" && " Si tu t'abonnes pendant l'essai, le premier prélèvement n'a lieu qu'à sa fin."}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// Premier accès d'un compte équipe confirmé qui n'appartient à aucune agence
function CreateAgencyScreen({ session, onCreated, onLogout }) {
  const [orgName, setOrgName] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(""); setSaving(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_organization`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_org_name: orgName, p_full_name: fullName }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || "Impossible de créer l'agence.");
      onCreated(Array.isArray(json) ? json[0] : json);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <AuthCard>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 26, lineHeight: 1.15, color: INK, marginBottom: 10 }}>Crée ton agence</div>
      <div style={{ fontSize: 12.5, color: "#5F7177", marginBottom: 16, lineHeight: 1.5 }}>
        Ton compte n'est rattaché à aucune agence. Crée la tienne pour commencer : tu en seras la Direction,
        avec <b>30 jours d'essai gratuit</b>. Tu pourras ensuite inviter ton équipe.
      </div>
      <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Nom de l'agence</label>
      <input value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="Agence Martin Immobilier" style={authInputStyle} />
      <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Ton nom</label>
      <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Prénom Nom" autoComplete="name" style={authInputStyle} />
      <AuthError>{error}</AuthError>
      <button onClick={submit} disabled={saving || orgName.trim().length < 2 || !fullName.trim()} style={authBtnStyle}>
        {saving ? "Création…" : "Créer mon agence"}
      </button>
      <div style={{ fontSize: 12.5, color: "#5F7177", marginTop: 16, lineHeight: 1.5, borderTop: `1px solid ${SAND}`, paddingTop: 12 }}>
        Tu rejoins une agence existante ? Demande à sa Direction de t'inviter avec cette adresse email, puis reconnecte-toi.
      </div>
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <span onClick={onLogout} style={authLinkStyle}>Se déconnecter</span>
      </div>
    </AuthCard>
  );
}

function LoginScreen({ onLogin, error, loading, onTenantSignup, onStaffSignup, signupInfo, notice }) {
  const [mode, setMode] = useState("staff"); // 'staff' | 'tenant'
  const [view, setView] = useState("login"); // 'login' | 'signup' | 'forgot'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetState, setResetState] = useState({ sending: false, sent: false, error: "" });
  const [newAgency, setNewAgency] = useState(false); // inscription d'une nouvelle agence (et non d'un invité)
  const signupMode = view === "signup";
  const setSignupMode = on => setView(on ? "signup" : "login");

  async function sendReset() {
    setResetState({ sending: true, sent: false, error: "" });
    try {
      await requestPasswordReset(email.trim());
      setResetState({ sending: false, sent: true, error: "" });
    } catch (e) { setResetState({ sending: false, sent: false, error: e.message }); }
  }

  const tabBtn = (active) => ({
    flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "center",
    borderRadius: 7, background: active ? "#fff" : "transparent", color: active ? INK : MUTED,
    boxShadow: active ? "0 1px 3px rgba(14,47,58,0.14)" : "none",
  });

  if (view === "forgot") {
    return (
      <AuthCard>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 26, lineHeight: 1.15, color: INK, marginBottom: 10 }}>Mot de passe oublié</div>
        {resetState.sent ? (
          <>
            <AuthInfo>
              Si un compte existe avec l'adresse <b>{email.trim()}</b>, tu vas recevoir un email avec un lien pour choisir un nouveau mot de passe.
              Pense à vérifier tes spams. Le lien est valable 1 heure.
            </AuthInfo>
            <button onClick={() => { setView("login"); setResetState({ sending: false, sent: false, error: "" }); }} style={authBtnStyle}>Retour à la connexion</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 16, lineHeight: 1.5 }}>
              Saisis l'adresse email de ton compte : nous t'enverrons un lien pour choisir un nouveau mot de passe.
            </div>
            <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="email" style={authInputStyle} />
            <AuthError>{resetState.error}</AuthError>
            <button onClick={sendReset} disabled={resetState.sending || !/^\S+@\S+\.\S+$/.test(email.trim())} style={authBtnStyle}>
              {resetState.sending ? "Envoi…" : "Envoyer le lien"}
            </button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <span onClick={() => setView("login")} style={authLinkStyle}>Retour à la connexion</span>
            </div>
          </>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 26, lineHeight: 1.15, color: INK, marginBottom: 18 }}>
          {view === "signup" ? (newAgency ? "Essayer PropOS" : "Créer mon accès") : "Se connecter"}
        </div>
        <div role="tablist" style={{ display: "flex", gap: 4, background: "#E3E9EB", borderRadius: 10, padding: 4, marginBottom: 22 }}>
          <div style={tabBtn(mode === "staff")} onClick={() => { setMode("staff"); setSignupMode(false); }}>Espace Équipe</div>
          <div style={tabBtn(mode === "tenant")} onClick={() => { setMode("tenant"); setNewAgency(false); }}>Espace Locataire</div>
        </div>

        {!signupMode && !error && <AuthInfo>{notice}</AuthInfo>}

        {signupMode ? (
          <>
            <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 14, lineHeight: 1.5 }}>
              {mode === "tenant"
                ? <>Utilise la <b>même adresse email</b> que celle enregistrée par ton agence sur ton bail — ton accès sera relié automatiquement.</>
                : newAgency
                  ? <><b>Nouvelle agence</b> : crée ton compte, confirme ton adresse email, puis connecte-toi pour créer ton agence (30 jours d'essai gratuit).</>
                  : <>Utilise l'<b>adresse email</b> sur laquelle tu as reçu ton invitation de la Direction — ton accès sera relié automatiquement.</>}
            </div>
            <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="email" style={authInputStyle} />
            <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Choisir un mot de passe</label>
            <PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
            <AuthError>{error}</AuthError>
            <AuthInfo>{signupInfo}</AuthInfo>
            <button onClick={() => (mode === "tenant" ? onTenantSignup(email, password) : onStaffSignup(email, password))} disabled={loading} style={authBtnStyle}>
              {loading ? "Création…" : newAgency ? "Créer mon compte" : "Créer mon accès"}
            </button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <span onClick={() => { setSignupMode(false); setNewAgency(false); }} style={authLinkStyle}>J'ai déjà un compte</span>
            </div>
          </>
        ) : (
          <>
            <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="email" style={authInputStyle} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: INK }}>Mot de passe</label>
              <span onClick={() => setView("forgot")} style={{ ...authLinkStyle, fontSize: 12.5 }}>Mot de passe oublié ?</span>
            </div>
            <PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            <AuthError>{error}</AuthError>
            <button onClick={() => onLogin(email, password, mode)} disabled={loading} style={authBtnStyle}>
              {loading ? "Connexion…" : "Se connecter"}
            </button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <span onClick={() => { setNewAgency(false); setSignupMode(true); }} style={authLinkStyle}>Première connexion ? Créer mon accès</span>
            </div>
            {mode === "staff" && (
              <div style={{ textAlign: "center", marginTop: 18, paddingTop: 14, borderTop: `1px solid ${SAND}`, fontSize: 12, color: "#5F7177" }}>
                Vous gérez une agence ?{" "}
                <span onClick={() => { setNewAgency(true); setSignupMode(true); }} style={{ ...authLinkStyle, fontWeight: 600 }}>Essayer PropOS gratuitement</span>
              </div>
            )}
          </>
        )}
    </AuthCard>
  );
}

function TenantPortal({ session, tenant, onLogout }) {
  const [data, setData] = useState({ leases: [], payments: [], documents: [], tickets: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ticketForm, setTicketForm] = useState({ category: "plomberie", description: "" });
  const [submittingTicket, setSubmittingTicket] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = session.access_token;
        const [leases, payments, documents, tickets] = await Promise.all([
          query("leases", token, "?select=*,properties(name,address,surface,pieces)"),
          query("payments", token, "?select=*,leases(properties(name))&order=due_date.desc"),
          query("documents", token, "?select=*&order=uploaded_at.desc"),
          query("maintenance_tickets", token, "?select=*,properties(name)&order=created_at.desc"),
        ]);
        setData({ leases, payments, documents, tickets });
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const activeLease = data.leases.find(l => l.status === "actif") || data.leases[0];

  async function viewDoc(doc) {
    try {
      const url = await getSignedDocumentUrl(doc.storage_path, session.access_token);
      window.open(url, "_blank");
    } catch (e) { alert(e.message); }
  }

  async function submitTicket() {
    if (!activeLease || !ticketForm.description) return;
    setSubmittingTicket(true);
    try {
      const [row] = await insertRow("maintenance_tickets", session.access_token, {
        organization_id: tenant.organization_id,
        property_id: activeLease.property_id,
        category: ticketForm.category,
        priority: "moyen",
        status: "ouvert",
        description: ticketForm.description,
        reported_by_tenant_id: tenant.id,
      });
      setData(d => ({ ...d, tickets: [{ ...row, properties: activeLease.properties }, ...d.tickets] }));
      setTicketForm({ category: "plomberie", description: "" });
    } catch (e) { alert(e.message); }
    finally { setSubmittingTicket(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: IVORY }}>
      <div className="tenant-head" style={{ background: NAVY_DEEP, padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Monogram size={32} onDark />
          <div style={{ color: "#fff", fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 17 }}>Mon espace locataire</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: "#D5E1E4", fontSize: 13 }}>{tenant.full_name}</span>
          <span onClick={onLogout} style={{ color: "#8FA7AE", fontSize: 12.5, cursor: "pointer" }}>Quitter</span>
        </div>
      </div>

      <div className="content" style={{ maxWidth: 760, margin: "0 auto", padding: 32 }}>
        {loading && <div style={{ color: "#5F7177", fontSize: 13 }}>Chargement…</div>}
        {error && <div style={{ background: "#F7E4E5", color: CORAL, padding: "12px 16px", borderRadius: 4, marginBottom: 20, fontSize: 13 }}>{error}</div>}

        {!loading && !activeLease && (
          <div style={{ color: "#5F7177", fontSize: 13, textAlign: "center", padding: 40 }}>
            Aucun bail actif n'est associé à ton compte pour l'instant. Contacte ta gestion locative.
          </div>
        )}

        {activeLease && (
          <>
            <SectionCard title="Mon logement" style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 17, color: NAVY_DEEP }}>{activeLease.properties?.name}</div>
              <div style={{ fontSize: 12.5, color: "#5F7177", marginTop: 4 }}>{activeLease.properties?.address}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 14, paddingTop: 14, borderTop: `1px solid #E3E9EB` }}>
                <div>
                  <div style={{ fontSize: 12, color: "#5F7177" }}>Loyer mensuel</div>
                  <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 17, fontWeight: 600, color: NAVY_DEEP }}>{Number(activeLease.rent).toLocaleString("fr-FR")} €</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#5F7177" }}>Début du bail</div>
                  <div style={{ fontSize: 13.5, marginTop: 2 }}>{activeLease.start_date}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#5F7177" }}>Statut</div>
                  <div style={{ fontSize: 13.5, marginTop: 2 }}>{label(leaseStatusLabel, activeLease.status)}</div>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Mes paiements" style={{ marginBottom: 18 }}>
              {data.payments.length === 0 && <div style={{ fontSize: 13, color: "#5F7177" }}>Aucun paiement enregistré.</div>}
              <table className="leases">
                <thead><tr><th>Échéance</th><th>Montant</th><th>Statut</th></tr></thead>
                <tbody>
                  {data.payments.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12.5 }}>{formatDate(p.due_date)}</td>
                      <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{Number(p.amount).toLocaleString("fr-FR")} €</td>
                      <td>
                        <span style={{
                          fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
                          background: isPaid(p) ? "#E3EFEA" : isOverdue(p) ? "#F7E4E5" : "#F8EEDC",
                          color: isPaid(p) ? SAGE : isOverdue(p) ? CORAL : "#A86A0C",
                        }}>{paymentStatusLabel(p)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>

            <SectionCard title="Mes documents" style={{ marginBottom: 18 }}>
              {data.documents.length === 0 && <div style={{ fontSize: 13, color: "#5F7177" }}>Aucun document partagé pour l'instant.</div>}
              {data.documents.map(d => (
                <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #E8EDEF" }}>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{d.name}</div>
                    <div style={{ fontSize: 12, color: "#5F7177" }}>{docTypeLabels[d.doc_type] || d.doc_type}</div>
                  </div>
                  <span onClick={() => viewDoc(d)} style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", fontWeight: 500 }}>Voir</span>
                </div>
              ))}
            </SectionCard>

            <SectionCard title="Signaler un problème">
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <select style={inputStyle} value={ticketForm.category} onChange={e => setTicketForm({ ...ticketForm, category: e.target.value })}>
                  <option value="plomberie">Plomberie</option>
                  <option value="electricite">Électricité</option>
                  <option value="climatisation">Climatisation</option>
                  <option value="structural">Structurel</option>
                  <option value="ascenseur">Ascenseur</option>
                  <option value="autre">Autre</option>
                </select>
              </div>
              <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical", marginBottom: 10 }}
                placeholder="Décris le problème rencontré…"
                value={ticketForm.description} onChange={e => setTicketForm({ ...ticketForm, description: e.target.value })} />
              <button style={primaryBtn} disabled={submittingTicket || !ticketForm.description} onClick={submitTicket}>
                {submittingTicket ? "Envoi…" : "Envoyer le signalement"}
              </button>

              {data.tickets.length > 0 && (
                <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${SAND}` }}>
                  <div style={{ fontSize: 12, color: "#5F7177", marginBottom: 8 }}>Mes signalements précédents</div>
                  {data.tickets.map(t => (
                    <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid #E8EDEF" }}>
                      <div style={{ fontSize: 12.5 }}>
                        <b style={{ fontWeight: 500 }}>{label(ticketCategoryLabel, t.category)}</b> — {t.description}
                        <div style={{ fontSize: 12, color: "#5F7177", marginTop: 2 }}>Signalé le {formatDate(t.created_at)}{t.resolved_at ? ` · résolu le ${formatDate(t.resolved_at)}` : ""}</div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: ticketStatusColor[t.status] || CORAL, whiteSpace: "nowrap" }}>{label(ticketStatusLabel, t.status)}</span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  // Retour d'un lien envoyé par email (réinitialisation, confirmation, lien expiré)
  const [authRedirect] = useState(() => {
    const r = readAuthRedirect();
    if (r?.type === "recovery" || r?.type === "invite") saveSession(null); // on ne restaure pas une ancienne session par-dessus
    return r;
  });
  // Lien « mot de passe oublié » ou invitation : la personne choisit son mot de passe
  const [recoveryToken, setRecoveryToken] = useState(authRedirect?.type === "recovery" || authRedirect?.type === "invite" ? authRedirect.access_token : null);
  const isInvite = authRedirect?.type === "invite";
  const [loginNotice, setLoginNotice] = useState(
    authRedirect?.type === "signup" || authRedirect?.type === "email_change"
      ? "Adresse email confirmée ✓ Tu peux maintenant te connecter."
      : ""
  );
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [tenantProfile, setTenantProfile] = useState(null);
  const [authError, setAuthError] = useState(authRedirect?.error || "");
  const [authLoading, setAuthLoading] = useState(false);
  const [signupInfo, setSignupInfo] = useState("");
  const [tab, setTab] = useState("overview");
  const [hrTab, setHrTab] = useState("employees");
  const [data, setData] = useState({ buildings: [], properties: [], tenants: [], leases: [], payments: [], maintenance: [], employees: [], payslips: [], leaveRequests: [], documents: [], staffInvites: [], teamMembers: [] });
  const [inviteModal, setInviteModal] = useState(false);
  const [updatingMember, setUpdatingMember] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false); // menu latéral sur mobile
  const [financeMonth, setFinanceMonth] = useState(currentMonthKey); // 'AAAA-MM' ou 'all'
  const [orgName, setOrgName] = useState("");
  const [orgInfo, setOrgInfo] = useState(null); // { subscription_status, trial_ends_at, … }
  const [billingReturn] = useState(() => {
    const v = new URLSearchParams(window.location.search).get("billing");
    if (v) window.history.replaceState(null, "", window.location.pathname);
    return v;
  });
  const [updatingTicket, setUpdatingTicket] = useState(null);
  const [ticketFilter, setTicketFilter] = useState("open"); // 'open' | 'resolu' | 'all'
  const [invitingStaff, setInvitingStaff] = useState(false);
  const [dataError, setDataError] = useState("");
  const [modal, setModal] = useState(null); // 'building' | 'property' | 'tenant' | 'lease' | null
  const [editingProperty, setEditingProperty] = useState(null);
  const [editingBuilding, setEditingBuilding] = useState(null);
  const [viewingEmployee, setViewingEmployee] = useState(null);
  const [employeeModal, setEmployeeModal] = useState(null); // 'add' | employee-object-being-edited | null
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [editingLease, setEditingLease] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [restoring, setRestoring] = useState(() => !!loadSession());
  // Compte équipe confirmé mais rattaché à aucune agence : écran « Crée ton agence »
  const [needsAgency, setNeedsAgency] = useState(false);

  // Rattache la session au profil équipe ou locataire, puis la mémorise
  async function establishSession(auth, mode) {
    setNeedsAgency(false);
    if (mode === "tenant") {
      let tenantRows = await query("tenants", auth.access_token, `?tenant_user_id=eq.${auth.user.id}&select=*`);
      // Fiche locataire créée par l'agence après l'inscription : on la rattache maintenant
      if (!tenantRows.length) tenantRows = await callRpc("claim_tenant_link", auth.access_token);
      if (!tenantRows.length) throw new Error("Aucun accès locataire n'est associé à ce compte. Vérifie ton email ou contacte ta gestion locative.");
      setTenantProfile(tenantRows[0]);
    } else {
      let profiles = await query("profiles", auth.access_token, `?id=eq.${auth.user.id}&select=*`);
      // Invitation envoyée après la création du compte (ex. membre retiré puis réinvité)
      if (!profiles.length) profiles = await callRpc("claim_staff_invite", auth.access_token);
      if (profiles.length) setProfile(profiles[0]);
      else setNeedsAgency(true);
    }
    const stored = { ...auth, mode };
    saveSession(stored);
    setSession(loadSession() || stored);
  }

  // Restauration de la session au rechargement de la page
  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;
    (async () => {
      try {
        const fresh = await refreshSession(stored.refresh_token);
        await establishSession(fresh, stored.mode);
      } catch (_) { saveSession(null); }
      finally { setRestoring(false); }
    })();
  }, []);

  // Renouvellement du jeton une minute avant son expiration
  useEffect(() => {
    if (!session?.refresh_token) return;
    const expiresAt = session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    const delay = Math.max(5000, (expiresAt - 60) * 1000 - Date.now());
    const timer = setTimeout(async () => {
      try {
        const fresh = await refreshSession(session.refresh_token);
        saveSession({ ...fresh, mode: session.mode });
        setSession(loadSession() || { ...fresh, mode: session.mode });
      } catch (_) {
        handleLogout();
        setAuthError("Ta session a expiré, reconnecte-toi.");
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [session]);

  async function handleLogin(email, password, mode) {
    setAuthError(""); setSignupInfo(""); setLoginNotice(""); setAuthLoading(true);
    try {
      const auth = await signIn(email, password);
      await establishSession(auth, mode);
    } catch (e) { setAuthError(e.message); }
    finally { setAuthLoading(false); }
  }

  async function handleTenantSignup(email, password) {
    setAuthError(""); setSignupInfo(""); setAuthLoading(true);
    try {
      const result = await signUp(email, password);
      if (result.access_token) {
        const tenantRows = await query("tenants", result.access_token, `?tenant_user_id=eq.${result.user.id}&select=*`);
        if (!tenantRows.length) {
          setSignupInfo("Compte créé, mais aucun bail n'est encore associé à cette adresse email. Contacte ta gestion locative.");
          return;
        }
        await establishSession(result, "tenant");
      } else {
        setSignupInfo("Compte créé ! Vérifie ta boîte mail pour confirmer ton adresse, puis connecte-toi.");
      }
    } catch (e) { setAuthError(e.message); }
    finally { setAuthLoading(false); }
  }

  async function handleStaffSignup(email, password) {
    setAuthError(""); setSignupInfo(""); setAuthLoading(true);
    try {
      const result = await signUp(email, password);
      if (result.access_token) {
        // Email confirmé d'office : invitation rattachée, sinon écran « Crée ton agence »
        await establishSession(result, "staff");
      } else {
        setSignupInfo("Compte créé ! Vérifie ta boîte mail pour confirmer ton adresse, puis connecte-toi.");
      }
    } catch (e) { setAuthError(e.message); }
    finally { setAuthLoading(false); }
  }

  function handleLogout() {
    if (session?.access_token) {
      fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }).catch(() => {});
    }
    saveSession(null);
    setSession(null); setProfile(null); setTenantProfile(null); setNeedsAgency(false);
  }

   const [showBulkImport, setShowBulkImport] = useState(false);
  async function refreshPayslips() {
    try {
      const payslips = await query("payslips", session.access_token, "?select=*,employees(full_name,role_title,department)");
      setData(d => ({ ...d, payslips }));
    } catch (e) { alert(e.message); }
  }
  useEffect(() => {
    if (!session || !profile) return;
    (async () => {
      try {
        const token = session.access_token;
        // Ne charger que ce que le rôle a le droit de voir (la base applique aussi ces règles via RLS)
        const can = PERMISSIONS[profile.role] || [];
        const canTenants = can.includes("tenants");
        const [buildings, properties, tenants, leases, payments, maintenance, documents] = await Promise.all([
          query("buildings", token, "?select=*&order=name.asc"),
          query("properties", token, "?select=*,buildings(name,address)"),
          canTenants ? query("tenants", token, "?select=*") : [],
          canTenants ? query("leases", token, "?select=*,tenants(full_name,email),properties(name,address)") : [],
          can.includes("finance") || canTenants ? query("payments", token, "?select=*,leases(tenants(full_name),properties(name))&order=due_date.desc") : [],
          query("maintenance_tickets", token, "?select=*,properties(name)"),
          canTenants ? query("documents", token, "?select=*&order=uploaded_at.desc") : [],
        ]);
        let employees = [], payslips = [], leaveRequests = [], staffInvites = [], teamMembers = [];
        if (profile.role === "direction") {
          [employees, payslips, leaveRequests, staffInvites, teamMembers] = await Promise.all([
            query("employees", token, "?select=*,buildings(name)"),
            query("payslips", token, "?select=*,employees(full_name,role_title,department)"),
            query("leave_requests", token, "?select=*,employees(full_name)"),
            query("staff_invites", token, "?select=*&order=created_at.desc"),
            query("profiles", token, "?select=*&order=full_name.asc"),
          ]);
        }
        setData({ buildings, properties, tenants, leases, payments, maintenance, employees, payslips, leaveRequests, documents, staffInvites, teamMembers });
        const loadOrg = () => query("organizations", token, "?select=name,subscription_status,trial_ends_at,current_period_end,billed_quantity")
          .then(rows => { setOrgName(rows[0]?.name || ""); setOrgInfo(rows[0] || null); }).catch(() => {});
        loadOrg();
        if (billingReturn === "success") { setTab("billing"); setTimeout(loadOrg, 4000); }
      } catch (e) { setDataError(e.message); }
    })();
    // Pas de rechargement complet à chaque renouvellement du jeton : seulement au changement d'utilisateur
  }, [session?.user?.id, profile]);

  // Fin d'essai sans abonnement, ou abonnement résilié : accès suspendu (uniquement si la facturation est active)
  const trialExpired = orgInfo?.subscription_status === "trialing" && !!orgInfo.trial_ends_at && new Date(orgInfo.trial_ends_at) < new Date();
  const accessSuspended = BILLING_ENABLED && !!orgInfo && (orgInfo.subscription_status === "canceled" || trialExpired);
  const allowedTabs = !profile ? [] : accessSuspended ? PERMISSIONS[profile.role].filter(k => k === "billing") : PERMISSIONS[profile.role];
  useEffect(() => { if (accessSuspended && profile?.role === "direction" && tab !== "billing") setTab("billing"); }, [accessSuspended, profile?.role, tab]);

  async function createStaffInvite(fields) {
    setInvitingStaff(true);
    try {
      const [row] = await insertRow("staff_invites", session.access_token, { ...fields, organization_id: profile.organization_id });
      setData(d => ({ ...d, staffInvites: [row, ...d.staffInvites] }));
      setInviteModal(false);
    } catch (e) { alert(e.message); }
    finally { setInvitingStaff(false); }
  }

  async function revokeStaffInvite(id) {
    try {
      await deleteRow("staff_invites", id, session.access_token);
      setData(d => ({ ...d, staffInvites: d.staffInvites.filter(i => i.id !== id) }));
    } catch (e) { alert(e.message); }
  }

  async function changeMemberRole(member, role) {
    if (role === member.role) return;
    if (!confirm(`Passer ${member.full_name} de « ${roles[member.role]} » à « ${roles[role]} » ? Le changement s'appliquera à sa prochaine connexion.`)) return;
    setUpdatingMember(member.id);
    try {
      const rows = await patchRow("profiles", member.id, session.access_token, { role });
      if (!rows.length) throw new Error("Modification refusée : tu ne peux pas modifier ton propre compte.");
      setData(d => ({ ...d, teamMembers: d.teamMembers.map(m => m.id === member.id ? { ...m, ...rows[0] } : m) }));
    } catch (e) { alert(e.message); }
    finally { setUpdatingMember(null); }
  }

  async function removeMember(member) {
    if (!confirm(`Retirer l'accès de ${member.full_name} ? Cette personne ne pourra plus se connecter à l'Espace Équipe.`)) return;
    setUpdatingMember(member.id);
    try {
      const rows = await deleteRow("profiles", member.id, session.access_token);
      if (!rows.length) throw new Error("Suppression refusée : tu ne peux pas retirer ton propre accès.");
      setData(d => ({ ...d, teamMembers: d.teamMembers.filter(m => m.id !== member.id) }));
    } catch (e) { alert(e.message); }
    finally { setUpdatingMember(null); }
  }

  async function updateTicketStatus(ticket, status) {
    setUpdatingTicket(ticket.id);
    try {
      const rows = await patchRow("maintenance_tickets", ticket.id, session.access_token, {
        status, resolved_at: status === "resolu" ? new Date().toISOString() : null,
      });
      if (!rows.length) throw new Error("Modification refusée.");
      setData(d => ({ ...d, maintenance: d.maintenance.map(t => t.id === ticket.id ? { ...t, ...rows[0] } : t) }));
    } catch (e) { alert(e.message); }
    finally { setUpdatingTicket(null); }
  }

  async function createBuilding(fields) {
    setSubmitting(true);
    try {
      const [row] = await insertRow("buildings", session.access_token, { ...fields, organization_id: profile.organization_id });
      setData(d => ({ ...d, buildings: [...d.buildings, row].sort((a, b) => a.name.localeCompare(b.name)) }));
      setModal(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function updateBuilding(id, fields) {
    setSubmitting(true);
    try {
      const [row] = await patchRow("buildings", id, session.access_token, fields);
      setData(d => ({
        ...d,
        buildings: d.buildings.map(b => b.id === id ? row : b),
        properties: d.properties.map(p => p.building_id === id ? { ...p, buildings: { name: row.name, address: row.address } } : p),
      }));
      setEditingBuilding(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function deleteBuilding(id) {
    setSubmitting(true);
    try {
      await deleteRow("buildings", id, session.access_token);
      setData(d => ({ ...d, buildings: d.buildings.filter(b => b.id !== id) }));
      setEditingBuilding(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function handleUploadPhoto(file) {
    setUploadingPhoto(true);
    try {
      const tempId = (viewingEmployee && viewingEmployee.id) || "new-" + Date.now();
      return await uploadPhoto(file, session.access_token, profile.organization_id, tempId);
    } catch (e) { alert(e.message); return null; }
    finally { setUploadingPhoto(false); }
  }

  async function uploadDocumentForTarget(file, docType, linkType, linkId) {
    setUploadingDocument(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${profile.organization_id}/${linkType}-${linkId}/${Date.now()}-${safeName}`;
      await uploadDocumentFile(file, storagePath, session.access_token);
      const [row] = await insertRow("documents", session.access_token, {
        organization_id: profile.organization_id,
        lease_id: linkType === "lease" ? linkId : null,
        tenant_id: linkType === "tenant" ? linkId : null,
        name: file.name,
        doc_type: docType,
        storage_path: storagePath,
      });
      setData(d => ({ ...d, documents: [row, ...d.documents] }));
    } catch (e) { alert(e.message); }
    finally { setUploadingDocument(false); }
  }

  async function viewDocument(doc) {
    try {
      const url = await getSignedDocumentUrl(doc.storage_path, session.access_token);
      window.open(url, "_blank");
    } catch (e) { alert(e.message); }
  }
   async function viewPayslip(p) {
    try {
      if (p.pdf_path) {
        const url = await getSignedPayslipUrl(p.pdf_path, session.access_token);
        window.open(url, "_blank");
      } else {
        const doc = await buildSalarySummaryPDF(
          p.employees?.full_name || "—", p.period, Number(p.gross_amount), Number(p.net_amount),
          p.employees?.role_title || null, p.employees?.department || null, orgName || "Employeur"
        );
        window.open(doc.output("bloburl"), "_blank");
      }
    } catch (e) { alert(e.message); }
  }

  async function removeDocument(doc) {
    if (!confirm(`Supprimer "${doc.name}" ?`)) return;
    try {
      await deleteDocumentFile(doc.storage_path, session.access_token);
      await deleteRow("documents", doc.id, session.access_token);
      setData(d => ({ ...d, documents: d.documents.filter(x => x.id !== doc.id) }));
    } catch (e) { alert(e.message); }
  }

  async function createEmployee(fields) {
    setSubmitting(true);
    try {
      const [row] = await insertRow("employees", session.access_token, { ...fields, organization_id: profile.organization_id });
      const building = data.buildings.find(b => b.id === fields.building_id);
      setData(d => ({ ...d, employees: [...d.employees, { ...row, buildings: building ? { name: building.name } : null }] }));
      setEmployeeModal(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function updateEmployee(id, fields) {
    setSubmitting(true);
    try {
      const [row] = await patchRow("employees", id, session.access_token, fields);
      const building = data.buildings.find(b => b.id === fields.building_id);
      const enriched = { ...row, buildings: building ? { name: building.name } : null };
      setData(d => ({ ...d, employees: d.employees.map(e => e.id === id ? enriched : e) }));
      setEmployeeModal(null);
      setViewingEmployee(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function deleteEmployee(id) {
    setSubmitting(true);
    try {
      await deleteRow("employees", id, session.access_token);
      setData(d => ({ ...d, employees: d.employees.filter(e => e.id !== id) }));
      setViewingEmployee(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function markPaymentPaid(id) {
    setSubmitting(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [row] = await patchRow("payments", id, session.access_token, { status: "paye", paid_date: today });
      setData(d => ({ ...d, payments: d.payments.map(p => p.id === id ? { ...p, ...row } : p) }));
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function approveLeave(id, status) {
    try {
      await patchRow("leave_requests", id, session.access_token, { status });
      setData(d => ({ ...d, leaveRequests: d.leaveRequests.map(l => l.id === id ? { ...l, status } : l) }));
    } catch (e) { alert(e.message); }
  }

  async function createProperty(fields) {
    setSubmitting(true);
    try {
      const [row] = await insertRow("properties", session.access_token, { ...fields, organization_id: profile.organization_id });
      const building = data.buildings.find(b => b.id === fields.building_id);
      setData(d => ({ ...d, properties: [{ ...row, buildings: building ? { name: building.name, address: building.address } : null }, ...d.properties] }));
      setModal(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function updateProperty(id, fields) {
    setSubmitting(true);
    try {
      const [row] = await patchRow("properties", id, session.access_token, fields);
      const building = data.buildings.find(b => b.id === fields.building_id);
      setData(d => ({ ...d, properties: d.properties.map(p => p.id === id ? { ...row, buildings: building ? { name: building.name, address: building.address } : null } : p) }));
      setEditingProperty(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function deleteProperty(id) {
    setSubmitting(true);
    try {
      await deleteRow("properties", id, session.access_token);
      setData(d => ({ ...d, properties: d.properties.filter(p => p.id !== id) }));
      setEditingProperty(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function updateTenant(id, fields) {
    setSubmitting(true);
    try {
      const [row] = await patchRow("tenants", id, session.access_token, fields);
      setData(d => ({
        ...d,
        tenants: d.tenants.map(t => t.id === id ? row : t),
        leases: d.leases.map(l => l.tenant_id === id ? { ...l, tenants: row } : l),
      }));
      setEditingTenant(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function deleteTenant(id) {
    setSubmitting(true);
    try {
      await deleteRow("tenants", id, session.access_token);
      setData(d => ({ ...d, tenants: d.tenants.filter(t => t.id !== id) }));
      setEditingTenant(null);
    } catch (e) { alert(e.message || "Suppression impossible : un bail actif est encore rattaché à ce locataire."); }
    finally { setSubmitting(false); }
  }

  async function updateLease(id, fields) {
    setSubmitting(true);
    try {
      const previous = data.leases.find(l => l.id === id);
      const [row] = await patchRow("leases", id, session.access_token, fields);
      const property = data.properties.find(p => p.id === fields.property_id);
      const leasesAfter = data.leases.map(l => l.id === id ? { ...l, ...row } : l);
      // Un bien est occupé tant qu'au moins un bail actif y est rattaché (on ne touche pas aux biens en maintenance)
      const statusUpdates = {};
      for (const propertyId of new Set([fields.property_id, previous?.property_id].filter(Boolean))) {
        const p = data.properties.find(x => x.id === propertyId);
        if (!p || p.status === "maintenance") continue;
        const target = leasesAfter.some(l => l.property_id === propertyId && l.status === "actif") ? "occupe" : "vacant";
        if (p.status !== target) {
          await patchRow("properties", propertyId, session.access_token, { status: target });
          statusUpdates[propertyId] = target;
        }
      }
      setData(d => ({
        ...d,
        leases: d.leases.map(l => l.id === id ? { ...l, ...row, properties: property || l.properties } : l),
        properties: d.properties.map(p => statusUpdates[p.id] ? { ...p, status: statusUpdates[p.id] } : p),
      }));
      setEditingLease(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function deleteLease(lease) {
    setSubmitting(true);
    try {
      await deleteRow("leases", lease.id, session.access_token);
      const stillOccupied = data.leases.some(l => l.id !== lease.id && l.property_id === lease.property_id && l.status === "actif");
      const property = data.properties.find(p => p.id === lease.property_id);
      const freeProperty = !stillOccupied && property && property.status === "occupe";
      if (freeProperty) await patchRow("properties", lease.property_id, session.access_token, { status: "vacant" });
      setData(d => ({
        ...d,
        leases: d.leases.filter(l => l.id !== lease.id),
        properties: d.properties.map(p => freeProperty && p.id === lease.property_id ? { ...p, status: "vacant" } : p),
      }));
      setEditingLease(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function createTenant(fields) {
    setSubmitting(true);
    try {
      const [row] = await insertRow("tenants", session.access_token, { ...fields, organization_id: profile.organization_id });
      setData(d => ({ ...d, tenants: [row, ...d.tenants] }));
      setModal(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function createLease(fields) {
    setSubmitting(true);
    try {
      const [row] = await insertRow("leases", session.access_token, {
        ...fields, organization_id: profile.organization_id, status: "actif",
      });
      const tenant = data.tenants.find(t => t.id === fields.tenant_id);
      const property = data.properties.find(p => p.id === fields.property_id);
      const enriched = { ...row, tenants: tenant, properties: property };
      setData(d => ({
        ...d,
        leases: [enriched, ...d.leases],
        properties: d.properties.map(p => p.id === fields.property_id ? { ...p, status: "occupe" } : p),
      }));
      setModal(null);
    } catch (e) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  const kpis = useMemo(() => {
    const total = data.properties.length;
    const occupied = data.properties.filter(p => p.status === "occupe").length;
    const vacant = data.properties.filter(p => p.status === "vacant").length;
    const rate = total ? Math.round((occupied / total) * 100) : 0;
    // Indicateurs financiers du mois en cours (impayés : à ce jour, toutes périodes)
    const month = computeMonthlyFinance(data.payments, currentMonthKey());
    const collected = month.receivedTotal;
    const late = month.overdueTotal;
    const lateCount = month.overdue.length;
    const recoveryRate = month.recoveryRate;
    const in60Days = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const expiringLeases = data.leases.filter(l => l.status === "actif" && l.end_date && l.end_date <= in60Days).length;
    const urgentTickets = data.maintenance.filter(t => t.status !== "resolu" && t.priority === "urgent").length;
    const openTickets = data.maintenance.filter(t => t.status !== "resolu").length;
    return { total, occupied, vacant, rate, collected, late, lateCount, recoveryRate, expiringLeases, urgentTickets, openTickets };
  }, [data]);

  if (recoveryToken) return <ResetPasswordScreen token={recoveryToken} welcome={isInvite} onDone={msg => { setRecoveryToken(null); setAuthError(""); setLoginNotice(msg); }} />;
  if (restoring) return <div style={{ minHeight: "100vh", background: NAVY_DEEP, display: "flex", alignItems: "center", justifyContent: "center", color: "#B9C9CE", fontSize: 13 }}>Chargement…</div>;
  if (session && tenantProfile) return <TenantPortal session={session} tenant={tenantProfile} onLogout={handleLogout} />;
  if (session && profile && accessSuspended && profile.role !== "direction") return (
    <AuthCard>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 18, color: NAVY_DEEP, marginBottom: 8 }}>Accès suspendu</div>
      <div style={{ fontSize: 13, color: "#5F7177", lineHeight: 1.55, marginBottom: 18 }}>
        L'abonnement de {orgName || "ton agence"} n'est plus actif. Les données sont conservées : contacte ta Direction pour réactiver l'accès.
      </div>
      <button style={authBtnStyle} onClick={handleLogout}>Se déconnecter</button>
    </AuthCard>
  );
  if (session && needsAgency) return (
    <CreateAgencyScreen session={session} onLogout={handleLogout}
      onCreated={newProfile => { setNeedsAgency(false); setProfile(newProfile); setTab("overview"); }} />
  );
  if (!session || !profile) return <LoginScreen onLogin={handleLogin} onTenantSignup={handleTenantSignup} onStaffSignup={handleStaffSignup} error={authError} signupInfo={signupInfo} loading={authLoading} notice={loginNotice} />;

  return (
    <div className="app-shell" style={{ display: "flex", minHeight: "100vh", color: INK }}>
      {menuOpen && <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`} style={{ width: 240, background: NAVY_DEEP, color: "#fff", padding: "24px 16px", position: "sticky", top: 0, height: "100vh", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 6px 26px" }}>
          <Monogram size={36} onDark />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 16.5, lineHeight: 1.2, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={orgName}>{orgName || "PropOS"}</div>
            <div style={{ fontSize: 12.5, color: "#8FA7AE", marginTop: 2 }}>PropOS</div>
          </div>
        </div>
        <nav>
          {NAV.map(item => {
            const active = tab === item.key;
            const allowed = allowedTabs.includes(item.key);
            if (item.key === "billing" && !allowed) return null; // page réservée à la Direction, masquée pour les autres
            return (
              <div key={item.key} className={allowed ? "navitem" : ""} onClick={() => { if (allowed) { setTab(item.key); setMenuOpen(false); } }}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 8, marginBottom: 2, background: active ? "rgba(176,141,87,0.14)" : "transparent", boxShadow: active ? `inset 2px 0 0 ${GOLD}` : "none", opacity: allowed ? 1 : 0.4, cursor: allowed ? "pointer" : "not-allowed" }}>
                <span style={{ fontSize: 14, fontWeight: active ? 500 : 400, color: active ? "#E9D7B4" : "#B9C9CE" }}>{item.label}</span>
                {!allowed && <span style={{ fontSize: 12 }}>🔒</span>}
              </div>
            );
          })}
        </nav>
        <div style={{ marginTop: "auto", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: GOLD, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12.5, color: NAVY_DEEP, fontWeight: 600 }}>
            {(profile.full_name || "?").split(" ").map(n => n[0]).join("").slice(0, 2)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5 }}>{profile.full_name}</div>
            <div style={{ fontSize: 12, color: "#8FA7AE" }}>{roles[profile.role]}</div>
          </div>
          <span style={{ cursor: "pointer", fontSize: 12 }} onClick={handleLogout}>Quitter</span>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, background: IVORY }}>
        <div className="topbar" style={{ background: IVORY, padding: "28px 40px 6px", display: "flex", alignItems: "center", gap: 12 }}>
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Ouvrir le menu"
            style={{ display: "none", background: "none", border: "none", fontSize: 22, color: NAVY_DEEP, cursor: "pointer", padding: 0, lineHeight: 1 }}>☰</button>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 26, letterSpacing: "-0.015em", color: INK, margin: 0 }}>{NAV.find(n => n.key === tab)?.label}</h1>
        </div>
        <div className="content" style={{ padding: "20px 40px 56px" }}>
          {dataError && <div style={{ background: "#F7E4E5", color: CORAL, padding: "12px 16px", borderRadius: 4, marginBottom: 20, fontSize: 13 }}>{dataError}</div>}
          {BILLING_ENABLED && profile.role === "direction" && orgInfo?.subscription_status === "trialing" && orgInfo.trial_ends_at && (() => {
            const days = Math.max(0, Math.ceil((new Date(orgInfo.trial_ends_at) - Date.now()) / 86400000));
            return (
              <div style={{ background: days <= 5 ? "#F7E4E5" : "#F8EEDC", color: days <= 5 ? CORAL : "#8A570A", padding: "10px 16px", borderRadius: 4, marginBottom: 20, fontSize: 12.5 }}>
                {days > 0 ? <>Période d'essai : <b>{days} jour{days > 1 ? "s" : ""} restant{days > 1 ? "s" : ""}</b> (jusqu'au {formatDate(orgInfo.trial_ends_at)}).</> : <>Ta période d'essai est terminée.</>}
              </div>
            );
          })()}

          {tab === "billing" && profile.role === "direction" && (
            <BillingPanel session={session} orgInfo={orgInfo} lots={data.properties.length} returnStatus={billingReturn} suspended={accessSuspended} />
          )}

          {tab === "overview" && (
            <>
              {(() => {
                // Phrase d'accueil : ce qui demande une action aujourd'hui, chaque élément mène au bon onglet
                const canMoney = allowedTabs.includes("tenants");
                const firstName = (profile.full_name || "").trim().split(/\s+/)[0];
                const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
                const items = [];
                if (canMoney && kpis.lateCount > 0) items.push({ key: "late", text: `${plural(kpis.lateCount, "loyer en retard", "loyers en retard")} (${kpis.late.toLocaleString("fr-FR")} €)`, tab: allowedTabs.includes("finance") ? "finance" : "tenants" });
                if (kpis.urgentTickets > 0) items.push({ key: "urgent", text: plural(kpis.urgentTickets, "ticket urgent", "tickets urgents"), tab: "maintenance" });
                if (canMoney && kpis.expiringLeases > 0) items.push({ key: "leases", text: `${plural(kpis.expiringLeases, "bail", "baux")} à renouveler`, tab: "tenants" });
                const reachable = items.filter(i => allowedTabs.includes(i.tab));
                return (
                  <section style={{ margin: "4px 0 28px", maxWidth: 860 }}>
                    <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 10 }}>{today.charAt(0).toUpperCase() + today.slice(1)}</div>
                    <p className="today" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500, fontSize: 29, lineHeight: 1.25, color: INK, letterSpacing: "-0.01em" }}>
                      Bonjour {firstName}.{" "}
                      {kpis.total === 0 ? "Ton agence est prête : commence par ajouter tes biens." :
                        reachable.length === 0 ? "Rien n'attend de réponse aujourd'hui." : (
                          <>
                            {reachable.map((item, i) => (
                              <React.Fragment key={item.key}>
                                {i > 0 && (i === reachable.length - 1 ? " et " : ", ")}
                                <button onClick={() => setTab(item.tab)}>{item.text}</button>
                              </React.Fragment>
                            ))}
                            {reachable.length === 1 ? " demande ton attention." : " demandent ton attention."}
                          </>
                        )}
                    </p>
                  </section>
                );
              })()}
              {kpis.total > 0 && (() => {
                const canMoney = allowedTabs.includes("tenants");
                const cells = [
                  <KpiCard key="biens" label="Biens gérés" value={kpis.total} sub={`${kpis.vacant} vacant${kpis.vacant > 1 ? "s" : ""}`} />,
                  <KpiCard key="occ" label="Taux d'occupation" value={`${kpis.rate} %`} sub={`${kpis.occupied} sur ${kpis.total} occupés`} />,
                  canMoney && <KpiCard key="cash" label="Encaissé ce mois" value={`${kpis.collected.toLocaleString("fr-FR")} €`} sub={monthLabel(currentMonthKey())} />,
                  canMoney && <KpiCard key="reco" label="Recouvrement du mois" value={kpis.recoveryRate === null ? "—" : `${kpis.recoveryRate} %`}
                    sub={kpis.lateCount ? `${kpis.lateCount} impayé${kpis.lateCount > 1 ? "s" : ""} à ce jour` : "Aucun impayé"} accent={kpis.recoveryRate !== null && kpis.recoveryRate < 95 ? CORAL : undefined} />,
                  !canMoney && <KpiCard key="tickets" label="Tickets ouverts" value={kpis.openTickets} sub={`${kpis.urgentTickets} urgent${kpis.urgentTickets > 1 ? "s" : ""}`} accent={kpis.urgentTickets > 0 ? CORAL : undefined} />,
                ].filter(Boolean);
                return (
                  <div className="grid-kpi" style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, 1fr)`, marginBottom: 24 }}>{cells}</div>
                );
              })()}
              {kpis.total === 0 && (
                <SectionCard title="Bien démarrer avec PropOS">
                  <div style={{ fontSize: 12.5, color: "#5F7177", marginBottom: 14 }}>Ton agence est prête. Quatre étapes pour la mettre en route :</div>
                  {[
                    { n: 1, label: "Ajoute tes immeubles", hint: "Optionnel si tu gères des biens isolés.", tab: "buildings", modal: "building", done: data.buildings.length > 0 },
                    { n: 2, label: "Ajoute tes biens", hint: "Référence, adresse, loyer et charges.", tab: "portfolio", modal: "property", done: data.properties.length > 0 },
                    { n: 3, label: "Enregistre tes locataires et leurs baux", hint: "Chaque locataire reçoit un email pour activer son espace.", tab: "tenants", modal: "tenant", done: data.leases.length > 0 },
                    { n: 4, label: "Invite ton équipe", hint: "Finance, gestion locative, maintenance : chacun voit ce qui le concerne.", tab: "hr", done: (data.teamMembers?.length || 0) > 1 },
                  ].filter(step => allowedTabs.includes(step.tab)).map(step => (
                    <div key={step.n} className="stack-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #E3E9EB" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, background: step.done ? SAGE : IVORY, color: step.done ? "#fff" : NAVY_DEEP }}>{step.done ? "✓" : step.n}</span>
                        <div>
                          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{step.label}</div>
                          <div style={{ fontSize: 12.5, color: "#5F7177" }}>{step.hint}</div>
                        </div>
                      </div>
                      <button style={addBtn} onClick={() => { setTab(step.tab); if (step.tab === "hr") { setHrTab("invites"); setInviteModal(true); } else if (step.modal) setModal(step.modal); }}>
                        {step.done ? "Ajouter" : "Commencer"}
                      </button>
                    </div>
                  ))}
                </SectionCard>
              )}
            </>
          )}

          {tab === "buildings" && (
            <SectionCard title={`${data.buildings.length} immeuble${data.buildings.length > 1 ? "s" : ""}`} action={
              <button style={addBtn} onClick={() => setModal("building")}>+ Ajouter un immeuble</button>
            }>
              {data.buildings.length === 0 && <div style={{ color: "#5F7177", fontSize: 13 }}>Aucun immeuble pour l'instant. Les biens sans immeuble restent listés individuellement dans le Portefeuille.</div>}
              <div className="grid-cards" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {data.buildings.map(b => {
                  const units = data.properties.filter(p => p.building_id === b.id);
                  const occupied = units.filter(u => u.status === "occupe").length;
                  const totalRent = units.reduce((s, u) => s + Number(u.rent || 0), 0);
                  return (
                    <div key={b.id} style={{ background: "#fff", border: `1px solid ${SAND}`, borderRadius: 12 }}>
                      <div style={{ padding: "20px 22px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 20, lineHeight: 1.2, color: INK }}>{b.name}</div>
                          <button onClick={() => setEditingBuilding(b)} style={{ background: "none", border: `1px solid ${SAND}`, borderRadius: 8, padding: "5px 11px", fontSize: 12.5, color: NAVY, cursor: "pointer", flexShrink: 0 }}>Modifier</button>
                        </div>
                        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>{b.address}</div>
                        {b.description && <div style={{ fontSize: 12, color: "#5F7177", marginTop: 8, fontStyle: "italic" }}>{b.description}</div>}
                        <div style={{ display: "flex", gap: 28, marginTop: 16, paddingTop: 16, borderTop: `1px solid #E3E9EB` }}>
                          <div>
                            <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 21, color: INK }}>{units.length}</div>
                            <div style={{ fontSize: 12, color: MUTED }}>Lots</div>
                          </div>
                          <div>
                            <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 21, color: INK }}>{units.length ? Math.round((occupied / units.length) * 100) : 0} %</div>
                            <div style={{ fontSize: 12, color: MUTED }}>Occupation</div>
                          </div>
                          <div>
                            <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 21, color: INK }}>{totalRent.toLocaleString("fr-FR")} €</div>
                            <div style={{ fontSize: 12, color: MUTED }}>Loyers mensuels</div>
                          </div>
                        </div>
                        {units.length > 0 && (
                          <div style={{ marginTop: 14 }}>
                            {units.map(u => (
                              <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #E8EDEF", fontSize: 12.5 }}>
                                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor[u.status], display: "inline-block" }} />
                                  {u.name}
                                </span>
                                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#5F7177" }}>{Number(u.rent).toLocaleString("fr-FR")} €</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {tab === "portfolio" && (
            <SectionCard title={`${data.properties.length} bien${data.properties.length > 1 ? "s" : ""}`} action={
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <ExportButtons
                  onExcel={() => exportExcel("propos-portefeuille", "Biens", data.properties.map(p => ({
                    Référence: p.reference, Nom: p.name, Immeuble: p.buildings?.name || "", Adresse: p.address,
                    "Surface (m²)": p.surface, Pièces: p.pieces, "Loyer (€)": p.rent, "Charges (€)": p.charges, Statut: statusLabel[p.status],
                  })))}
                  onPDF={() => exportPDFTable("Portefeuille immobilier", ["Réf.", "Nom", "Immeuble", "Loyer", "Statut"],
                    data.properties.map(p => [p.reference, p.name, p.buildings?.name || "—", pdfNum(p.rent), statusLabel[p.status]]),
                    "propos-portefeuille")}
                />
                <button style={addBtn} onClick={() => setModal("property")}>+ Ajouter un bien</button>
              </div>
            }>
              {data.properties.length === 0 && <div style={{ color: "#5F7177", fontSize: 13, marginBottom: 12 }}>Aucun bien pour l'instant.</div>}
              <div className="grid-cards" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                {data.properties.map(p => (
                  <button key={p.id} onClick={() => setEditingProperty(p)} title="Modifier le bien"
                    style={{ textAlign: "left", font: "inherit", color: INK, background: "#fff", border: `1px solid ${SAND}`, borderRadius: 12, padding: "16px 18px 18px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%" }}>
                      <span style={{ fontSize: 12, color: MUTED }}>{p.reference}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, padding: "3px 9px", borderRadius: 999, color: statusColor[p.status], background: statusBg[p.status] }}>{statusLabel[p.status]}</span>
                    </div>
                    <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 17, lineHeight: 1.2, marginTop: 8 }}>{p.name}</div>
                    <div style={{ fontSize: 12.5, color: MUTED }}>{[p.buildings?.name, p.address].filter(Boolean).join(", ")}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14, paddingTop: 12, borderTop: "1px solid #E3E9EB", width: "100%" }}>
                      <span style={{ fontSize: 12.5, color: MUTED }}>{[p.surface && `${p.surface} m²`, p.pieces && `${p.pieces} pièce${p.pieces > 1 ? "s" : ""}`].filter(Boolean).join(", ")}</span>
                      <span><span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 16 }}>{Number(p.rent).toLocaleString("fr-FR")} €</span><span style={{ fontSize: 12.5, color: MUTED }}> / mois</span></span>
                    </div>
                  </button>
                ))}
              </div>
            </SectionCard>
          )}

          {tab === "tenants" && (
            <SectionCard title="Baux" action={
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <ExportButtons
                  onExcel={() => exportExcel("propos-baux", "Baux", data.leases.map(l => ({
                    Locataire: l.tenants?.full_name || "", Email: l.tenants?.email || "", Bien: l.properties?.name || "",
                    "Loyer (€)": l.rent, Statut: label(leaseStatusLabel, l.status),
                  })))}
                  onPDF={() => exportPDFTable("Baux & locataires", ["Locataire", "Bien", "Loyer", "Statut"],
                    data.leases.map(l => [l.tenants?.full_name || "—", l.properties?.name || "—", pdfNum(l.rent), label(leaseStatusLabel, l.status)]),
                    "propos-baux")}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={addBtn} onClick={() => setModal("tenant")}>+ Locataire</button>
                  <button style={addBtn} onClick={() => setModal("lease")}>+ Bail</button>
                </div>
              </div>
            }>
              {data.leases.length === 0 && <div style={{ color: "#5F7177", fontSize: 13, marginBottom: 12 }}>Aucun bail pour l'instant.</div>}
              <table className="leases">
                <thead><tr><th>Locataire</th><th>Bien</th><th>Loyer</th><th>Statut</th><th></th></tr></thead>
                <tbody>
                  {data.leases.map(l => (
                    <tr key={l.id}>
                      <td>{l.tenants?.full_name}<div style={{ fontSize: 12, color: "#5F7177" }}>{l.tenants?.email}</div></td>
                      <td>{l.properties?.name} — {l.properties?.address}</td>
                      <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{Number(l.rent).toLocaleString("fr-FR")} €</td>
                      <td>{label(leaseStatusLabel, l.status)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span onClick={() => setEditingTenant(l.tenants ? { ...l.tenants, id: l.tenant_id } : { id: l.tenant_id, full_name: "", email: "", phone: "" })}
                          title="Modifier le locataire"
                          style={{ cursor: "pointer", fontSize: 12.5, color: NAVY, marginRight: 14 }}>Locataire</span>
                        <span onClick={() => setEditingLease(l)} title="Modifier le bail" style={{ cursor: "pointer", fontSize: 12.5, color: NAVY }}>Bail</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          )}

          {tab === "finance" && (() => {
            const fin = computeMonthlyFinance(data.payments, financeMonth);
            const period = monthLabel(financeMonth);
            const unpaid = data.payments.filter(p => !isPaid(p)).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
            const received = [...fin.received].sort((a, b) => String(b.paid_date || b.due_date).localeCompare(String(a.paid_date || a.due_date)));
            const receivedRows = received.map(p => ({
              Locataire: p.leases?.tenants?.full_name || "", Bien: p.leases?.properties?.name || "",
              "Échéance": p.due_date, "Date de paiement": p.paid_date || p.due_date, "Montant (€)": Number(p.amount),
            }));
            return (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#5F7177" }}>
                    Période
                    <select style={{ ...inputStyle, width: "auto", padding: "7px 10px" }} value={financeMonth} onChange={e => setFinanceMonth(e.target.value)}>
                      {availableMonths(data.payments).map(m => <option key={m} value={m}>{monthLabel(m)}{m === currentMonthKey() ? " (en cours)" : ""}</option>)}
                      <option value="all">Tous les mois</option>
                    </select>
                  </label>
                  <button
                    onClick={() => exportFinanceReport(fin, financeMonth, kpis, `propos-rapport-financier-${financeMonth}`)}
                    style={{ background: NAVY_DEEP, color: "#fff", border: "none", borderRadius: 3, padding: "9px 16px", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}>
                    Rapport {financeMonth === "all" ? "global" : period.toLowerCase()} (PDF)
                  </button>
                </div>
                <div className="grid-kpi" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18, marginBottom: 20 }}>
                  <KpiCard label="Loyers appelés" value={`${fin.dueTotal.toLocaleString("fr-FR")} €`}
                    sub={`dont ${fin.dueCollected.toLocaleString("fr-FR")} € encaissés`} accent={NAVY} />
                  <KpiCard label="Encaissé sur la période" value={`${fin.receivedTotal.toLocaleString("fr-FR")} €`}
                    sub={`${fin.received.length} paiement(s) reçu(s)`} accent={SAGE} />
                  <KpiCard label="Taux de recouvrement" value={fin.recoveryRate === null ? "—" : `${fin.recoveryRate}%`}
                    sub="sur les échéances arrivées à terme" accent={fin.recoveryRate === null || fin.recoveryRate >= 95 ? SAGE : CORAL} />
                  <KpiCard label="Impayés à ce jour" value={`${fin.overdueTotal.toLocaleString("fr-FR")} €`}
                    sub={`${fin.overdue.length} échéance(s), toutes périodes`} accent={fin.overdueTotal > 0 ? CORAL : SAGE} />
                </div>

                {unpaid.length > 0 && (
                  <SectionCard title="À encaisser" style={{ marginBottom: 18 }}
                    action={<span style={{ fontSize: 12, color: "#5F7177" }}>{fin.overdue.length} en retard · {unpaid.length - fin.overdue.length} à venir</span>}>
                    <table className="leases">
                      <thead><tr><th>Locataire</th><th>Bien</th><th>Échéance</th><th>Montant</th><th>Statut</th><th></th></tr></thead>
                      <tbody>
                        {unpaid.map(p => {
                          const late = isOverdue(p);
                          return (
                            <tr key={p.id}>
                              <td>{p.leases?.tenants?.full_name || "—"}</td>
                              <td>{p.leases?.properties?.name || "—"}</td>
                              <td style={{ fontSize: 12.5, color: "#5F7177" }}>{formatDate(p.due_date)}</td>
                              <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600 }}>{Number(p.amount).toLocaleString("fr-FR")} €</td>
                              <td>
                                <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: late ? "#F7E4E5" : "#F8EEDC", color: late ? CORAL : "#A86A0C" }}>
                                  {late ? "En retard" : "À venir"}
                                </span>
                              </td>
                              <td>
                                <button disabled={submitting} onClick={() => markPaymentPaid(p.id)}
                                  style={{ background: SAGE, color: "#fff", border: "none", borderRadius: 3, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                  ✓ Marquer reçu
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </SectionCard>
                )}

                <SectionCard title={`Encaissements — ${period}`} action={
                  <ExportButtons
                    onExcel={() => exportExcel(`propos-encaissements-${financeMonth}`, "Encaissements", receivedRows)}
                    onPDF={() => exportPDFTable(`Encaissements — ${period}`, ["Locataire", "Bien", "Échéance", "Payé le", "Montant"],
                      received.map(p => [p.leases?.tenants?.full_name || "—", p.leases?.properties?.name || "—", formatDate(p.due_date), formatDate(p.paid_date || p.due_date), pdfNum(p.amount)]),
                      `propos-encaissements-${financeMonth}`)}
                  />
                }>
                  {received.length === 0 && <div style={{ fontSize: 13, color: "#5F7177" }}>Aucun paiement reçu sur cette période.</div>}
                  {received.length > 0 && (
                    <table className="leases">
                      <thead><tr><th>Locataire</th><th>Bien</th><th>Échéance</th><th>Payé le</th><th>Montant</th></tr></thead>
                      <tbody>
                        {received.slice(0, 50).map(p => (
                          <tr key={p.id}>
                            <td>{p.leases?.tenants?.full_name || "—"}</td>
                            <td>{p.leases?.properties?.name || "—"}</td>
                            <td style={{ fontSize: 12.5, color: "#5F7177" }}>{formatDate(p.due_date)}</td>
                            <td style={{ fontSize: 12.5, color: "#5F7177" }}>{formatDate(p.paid_date || p.due_date)}</td>
                            <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{Number(p.amount).toLocaleString("fr-FR")} €</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {received.length > 50 && (
                    <div style={{ fontSize: 12, color: "#5F7177", marginTop: 10, textAlign: "center" }}>
                      Affichage des 50 paiements les plus récents sur {received.length} (l'export contient la totalité).
                    </div>
                  )}
                </SectionCard>
              </>
            );
          })()}

          {tab === "maintenance" && (() => {
            const priorityRank = { urgent: 0, eleve: 1, moyen: 2, faible: 3 };
            const openCount = data.maintenance.filter(t => t.status !== "resolu").length;
            const tickets = data.maintenance
              .filter(t => ticketFilter === "all" || (ticketFilter === "resolu" ? t.status === "resolu" : t.status !== "resolu"))
              .sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || String(b.created_at).localeCompare(String(a.created_at)));
            const smallBtn = (bg, color) => ({ background: bg, color, border: "none", borderRadius: 3, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" });
            return (
              <SectionCard title="Tickets de maintenance" action={
                <ExportButtons
                  onExcel={() => exportExcel("propos-maintenance", "Tickets", data.maintenance.map(t => ({
                    Bien: t.properties?.name || "", Catégorie: label(ticketCategoryLabel, t.category), Priorité: label(ticketPriorityLabel, t.priority),
                    Statut: label(ticketStatusLabel, t.status), Description: t.description || "", "Signalé le": formatDate(t.created_at), "Résolu le": t.resolved_at ? formatDate(t.resolved_at) : "",
                  })))}
                  onPDF={() => exportPDFTable("Tickets de maintenance", ["Bien", "Catégorie", "Priorité", "Statut", "Signalé le"],
                    data.maintenance.map(t => [t.properties?.name || "—", label(ticketCategoryLabel, t.category), label(ticketPriorityLabel, t.priority), label(ticketStatusLabel, t.status), formatDate(t.created_at)]),
                    "propos-maintenance")}
                />
              }>
                <div className="subtabs" style={{ display: "flex", gap: 6, marginBottom: 10, borderBottom: `1px solid ${SAND}` }}>
                  {[{ key: "open", label: `À traiter (${openCount})` }, { key: "resolu", label: `Résolus (${data.maintenance.length - openCount})` }, { key: "all", label: "Tous" }].map(f => (
                    <div key={f.key} onClick={() => setTicketFilter(f.key)} style={{ padding: "8px 12px", fontSize: 12.5, cursor: "pointer", color: ticketFilter === f.key ? NAVY_DEEP : "#5F7177", fontWeight: ticketFilter === f.key ? 600 : 400, borderBottom: ticketFilter === f.key ? `2px solid ${GOLD}` : "2px solid transparent" }}>{f.label}</div>
                  ))}
                </div>
                {tickets.length === 0 && <div style={{ color: "#5F7177", fontSize: 13, padding: "12px 0" }}>{ticketFilter === "open" ? "Aucun ticket à traiter." : "Aucun ticket."}</div>}
                {tickets.map(t => {
                  const busy = updatingTicket === t.id;
                  return (
                    <div key={t.id} className="stack-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, padding: "14px 0", borderBottom: "1px solid #E3E9EB" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 13.5 }}>{label(ticketCategoryLabel, t.category)} — {t.properties?.name || "—"}</div>
                        {t.description && <div style={{ fontSize: 12.5, color: INK, marginTop: 4, lineHeight: 1.45 }}>{t.description}</div>}
                        <div style={{ fontSize: 12.5, color: "#5F7177", marginTop: 5 }}>
                          Priorité : <span style={{ color: ticketPriorityColor[t.priority], fontWeight: 600 }}>{label(ticketPriorityLabel, t.priority)}</span>
                          {" · "}Signalé le {formatDate(t.created_at)}{t.reported_by_tenant_id ? " par le locataire" : ""}
                          {t.resolved_at && ` · Résolu le ${formatDate(t.resolved_at)}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 20, color: ticketStatusColor[t.status] || CORAL, background: t.status === "resolu" ? "#E3EFEA" : t.status === "en_cours" ? "#F8EEDC" : "#F7E4E5" }}>
                          {label(ticketStatusLabel, t.status)}
                        </span>
                        <div style={{ display: "flex", gap: 6 }}>
                          {t.status === "ouvert" && (
                            <button disabled={busy} onClick={() => updateTicketStatus(t, "en_cours")} style={smallBtn("#F8EEDC", "#A86A0C")}>Prendre en charge</button>
                          )}
                          {t.status !== "resolu" && (
                            <button disabled={busy} onClick={() => updateTicketStatus(t, "resolu")} style={smallBtn(SAGE, "#fff")}>✓ Marquer résolu</button>
                          )}
                          {t.status === "resolu" && (
                            <button disabled={busy} onClick={() => updateTicketStatus(t, "ouvert")} style={smallBtn(IVORY, "#5F7177")}>Rouvrir</button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </SectionCard>
            );
          })()}

          {tab === "hr" && (
            <>
              <div style={{ background: NAVY_DEEP, color: "#fff", padding: "9px 16px", borderRadius: 4, marginBottom: 18, fontSize: 12.5 }}>
                Données confidentielles, visibles par la Direction uniquement
              </div>
              <div className="hr-head" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 18, borderBottom: `1px solid ${SAND}` }}>
                <div className="subtabs" style={{ display: "flex", gap: 6 }}>
                  {[{ key: "employees", label: "Employés" }, { key: "payroll", label: "Fiches de paie" }, { key: "leave", label: "Congés" }, { key: "invites", label: "Accès Équipe" }].map(s => (
                    <div key={s.key} onClick={() => setHrTab(s.key)} style={{ padding: "10px 16px", fontSize: 13, cursor: "pointer", color: hrTab === s.key ? NAVY_DEEP : "#5F7177", fontWeight: hrTab === s.key ? 600 : 400, borderBottom: hrTab === s.key ? `2px solid ${GOLD}` : "2px solid transparent" }}>{s.label}</div>
                  ))}
                </div>
                {hrTab === "employees" && (
                  <button style={{ ...addBtn, marginBottom: 8 }} onClick={() => setEmployeeModal("add")}>+ Ajouter un employé</button>
                )}
                {hrTab === "invites" && (
                  <button style={{ ...addBtn, marginBottom: 8 }} onClick={() => setInviteModal(true)}>+ Inviter un membre</button>
                )}
              </div>
              {hrTab === "employees" && (
                <>
                  {Object.entries(
                    data.employees.reduce((groups, e) => {
                      const key = e.buildings?.name || "Siège / Direction";
                      (groups[key] = groups[key] || []).push(e);
                      return groups;
                    }, {})
                  ).map(([buildingName, emps]) => {
                    const byRole = emps.reduce((g, e) => {
                      (g[e.role_title] = g[e.role_title] || []).push(e);
                      return g;
                    }, {});
                    return (
                      <SectionCard key={buildingName} title={buildingName} style={{ marginBottom: 16 }}
                        action={<span style={{ fontSize: 12, color: "#5F7177" }}>{emps.length} personne(s)</span>}>
                        {Object.entries(byRole).map(([role, list]) => (
                          <div key={role} style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 13, color: INK, fontWeight: 600, marginBottom: 8 }}>
                              {role} ({list.length})
                            </div>
                            <div className="grid-cards" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                              {list.map(e => (
                                <div key={e.id} onClick={() => setViewingEmployee(e)}
                                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: `1px solid ${SAND}`, borderRadius: 4, cursor: "pointer" }}
                                  onMouseEnter={ev => ev.currentTarget.style.background = IVORY}
                                  onMouseLeave={ev => ev.currentTarget.style.background = "#fff"}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <PhotoAvatar url={e.photo_url} name={e.full_name} size={32} />
                                    <div>
                                      <div style={{ fontSize: 13, fontWeight: 500 }}>{e.full_name}</div>
                                      <div style={{ fontSize: 12, color: "#5F7177" }}>{e.email}</div>
                                    </div>
                                  </div>
                                  <span style={{
                                    fontSize: 12, fontWeight: 600, padding: "3px 8px", borderRadius: 20,
                                    background: e.status === "actif" ? "#E3EFEA" : "#F8EEDC",
                                    color: e.status === "actif" ? SAGE : "#A86A0C"
                                  }}>{label(employeeStatusLabel, e.status)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </SectionCard>
                    );
                  })}
                </>
              )}
                                          {hrTab === "payroll" && (
                <>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                    <button style={addBtn} onClick={() => setShowBulkImport(!showBulkImport)}>
                      {showBulkImport ? "Fermer l'import" : "⬆ Importer des fiches (PDF)"}
                    </button>
                  </div>
                  {showBulkImport && (
                    <BulkPayslipImport payslips={data.payslips} employees={data.employees} session={session} onDone={refreshPayslips} />
                  )}
                  <SectionCard title="Fiches de paie">
                    <table className="leases">
                      <thead><tr><th>Employé</th><th>Période</th><th>Brut</th><th>Net</th><th>Statut</th><th>Fiche</th></tr></thead>
                      <tbody>
                        {data.payslips.map(p => (
                          <tr key={p.id}><td>{p.employees?.full_name}</td><td>{p.period}</td>
                            <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{Number(p.gross_amount).toLocaleString("fr-FR")} €</td>
                            <td style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{Number(p.net_amount).toLocaleString("fr-FR")} €</td>
                            <td>{p.status}</td>
                            <td>
                              <span onClick={() => viewPayslip(p)} style={{ fontSize: 12.5, color: NAVY, cursor: "pointer", fontWeight: 500 }}>
                                {p.pdf_path ? "Voir le bulletin" : "Récapitulatif"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </SectionCard>
                </>
              )}
              {hrTab === "leave" && (
                <SectionCard title="Demandes de congés">
                  {data.leaveRequests.map(l => (
                    <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #E3E9EB" }}>
                      <div>
                        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{l.employees?.full_name} — {l.leave_type}</div>
                        <div style={{ fontSize: 12.5, color: "#5F7177" }}>Du {formatDate(l.start_date)} au {formatDate(l.end_date)}, {l.days} jour{l.days > 1 ? "s" : ""}</div>
                      </div>
                      {l.status === "en_attente" ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => approveLeave(l.id, "approuve")} style={{ background: "#E3EFEA", border: "none", color: SAGE, borderRadius: 3, width: 28, height: 28, cursor: "pointer" }}>✓</button>
                          <button onClick={() => approveLeave(l.id, "refuse")} style={{ background: "#F7E4E5", border: "none", color: CORAL, borderRadius: 3, width: 28, height: 28, cursor: "pointer" }}>✕</button>
                        </div>
                      ) : <span style={{ fontSize: 12, fontWeight: 600, color: l.status === "approuve" ? SAGE : CORAL }}>{label(leaveStatusLabel, l.status)}</span>}
                    </div>
                  ))}
                </SectionCard>
              )}
              {hrTab === "invites" && (
                <SectionCard title={`Membres de l'équipe — ${data.teamMembers.length}`} style={{ marginBottom: 18 }}>
                  {data.teamMembers.length === 0 && <div style={{ fontSize: 13, color: "#5F7177" }}>Aucun membre.</div>}
                  {data.teamMembers.map(m => {
                    const isMe = m.id === profile.id;
                    const busy = updatingMember === m.id;
                    return (
                      <div key={m.id} className="stack-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #E3E9EB" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          <PhotoAvatar name={m.full_name} size={32} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{m.full_name}{isMe && <span style={{ fontSize: 12, color: "#5F7177", fontWeight: 400 }}> (toi)</span>}</div>
                            <div style={{ fontSize: 12.5, color: "#5F7177" }}>{m.email || "—"}</div>
                          </div>
                        </div>
                        {isMe ? (
                          <span style={{ fontSize: 12, color: "#5F7177" }}>{roles[m.role]}</span>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <select style={{ ...inputStyle, width: 170, padding: "6px 8px", fontSize: 12.5 }} value={m.role} disabled={busy}
                              onChange={e => changeMemberRole(m, e.target.value)}>
                              {Object.entries(roles).map(([key, lbl]) => <option key={key} value={key}>{lbl}</option>)}
                            </select>
                            <span onClick={() => !busy && removeMember(m)}
                              style={{ fontSize: 12.5, color: CORAL, cursor: busy ? "wait" : "pointer", fontWeight: 500, whiteSpace: "nowrap" }}>Retirer l'accès</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </SectionCard>
              )}
              {hrTab === "invites" && (
                <SectionCard title="Invitations en attente">
                  {data.staffInvites.filter(i => !i.used_at).length === 0 && (
                    <div style={{ fontSize: 13, color: "#5F7177" }}>Aucune invitation en attente.</div>
                  )}
                  {data.staffInvites.filter(i => !i.used_at).map(i => (
                    <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #E3E9EB" }}>
                      <div>
                        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{i.full_name || i.email}</div>
                        <div style={{ fontSize: 12.5, color: "#5F7177" }}>{i.email} · {roles[i.role] || i.role}</div>
                      </div>
                      <span onClick={() => { if (confirm(`Annuler l'invitation de ${i.email} ?`)) revokeStaffInvite(i.id); }}
                        style={{ fontSize: 12.5, color: CORAL, cursor: "pointer", fontWeight: 500 }}>Révoquer</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 12.5, color: "#5F7177", marginTop: 12, lineHeight: 1.5 }}>
                    Pour modifier une invitation (email ou rôle), révoque-la puis renvoie-en une nouvelle.
                  </div>
                </SectionCard>
              )}
            </>
          )}
        </div>
      </main>

      {modal === "property" && (
        <Modal title="Ajouter un bien" onClose={() => setModal(null)}>
          <AddPropertyForm buildings={data.buildings} onSubmit={createProperty} submitting={submitting} />
        </Modal>
      )}
      {modal === "tenant" && (
        <Modal title="Ajouter un locataire" onClose={() => setModal(null)}>
          <AddTenantForm onSubmit={createTenant} submitting={submitting} />
        </Modal>
      )}
      {modal === "lease" && (
        <Modal title="Créer un bail" onClose={() => setModal(null)}>
          <AddLeaseForm properties={data.properties} tenants={data.tenants} onSubmit={createLease} submitting={submitting} />
        </Modal>
      )}
      {editingProperty && (
        <Modal title="Modifier le bien" onClose={() => setEditingProperty(null)}>
          <EditPropertyForm
            property={editingProperty}
            buildings={data.buildings}
            submitting={submitting}
            onSubmit={fields => updateProperty(editingProperty.id, fields)}
            onDelete={() => deleteProperty(editingProperty.id)}
          />
        </Modal>
      )}
      {modal === "building" && (
        <Modal title="Ajouter un immeuble" onClose={() => setModal(null)}>
          <AddBuildingForm onSubmit={createBuilding} submitting={submitting} />
        </Modal>
      )}
      {inviteModal && (
        <Modal title="Inviter un membre de l'équipe" onClose={() => setInviteModal(false)}>
          <InviteStaffForm onSubmit={createStaffInvite} submitting={invitingStaff} />
        </Modal>
      )}
      {editingBuilding && (
        <Modal title="Modifier l'immeuble" onClose={() => setEditingBuilding(null)}>
          <EditBuildingForm
            building={editingBuilding}
            submitting={submitting}
            onSubmit={fields => updateBuilding(editingBuilding.id, fields)}
            onDelete={() => deleteBuilding(editingBuilding.id)}
          />
        </Modal>
      )}
      {viewingEmployee && (
        <Modal title="Fiche employé" onClose={() => setViewingEmployee(null)}>
          <EmployeeCard
            employee={viewingEmployee}
            onEdit={() => setEmployeeModal(viewingEmployee)}
            onDelete={() => deleteEmployee(viewingEmployee.id)}
          />
        </Modal>
      )}
      {employeeModal && (
        <Modal title={employeeModal === "add" ? "Ajouter un employé" : "Modifier l'employé"} onClose={() => setEmployeeModal(null)}>
          <EmployeeForm
            initial={employeeModal === "add" ? null : employeeModal}
            buildings={data.buildings}
            submitting={submitting}
            uploadingPhoto={uploadingPhoto}
            onUploadPhoto={handleUploadPhoto}
            onSubmit={fields => employeeModal === "add" ? createEmployee(fields) : updateEmployee(employeeModal.id, fields)}
          />
        </Modal>
      )}
      {editingTenant && (
        <Modal title="Modifier le locataire" onClose={() => setEditingTenant(null)}>
          <EditTenantForm
            tenant={editingTenant}
            submitting={submitting}
            onSubmit={fields => updateTenant(editingTenant.id, fields)}
            onDelete={() => deleteTenant(editingTenant.id)}
            documents={data.documents.filter(d => d.tenant_id === editingTenant.id)}
            uploadingDoc={uploadingDocument}
            onUploadDoc={uploadDocumentForTarget}
            onViewDoc={viewDocument}
            onDeleteDoc={removeDocument}
          />
        </Modal>
      )}
      {editingLease && (
        <Modal title="Modifier le bail" onClose={() => setEditingLease(null)}>
          <EditLeaseForm
            lease={editingLease}
            properties={data.properties}
            submitting={submitting}
            onSubmit={fields => updateLease(editingLease.id, fields)}
            onDelete={() => deleteLease(editingLease)}
            documents={data.documents.filter(d => d.lease_id === editingLease.id)}
            uploadingDoc={uploadingDocument}
            onUploadDoc={uploadDocumentForTarget}
            onViewDoc={viewDocument}
            onDeleteDoc={removeDocument}
          />
        </Modal>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
