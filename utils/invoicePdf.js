import PDFDocument from "pdfkit";

// Patient invoice for a clinic's treatments & payments, rendered with pdfkit.
// Used for download / print in the app and as the attachment on the emailed
// copy, so all three always show the same document.

const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";

const money = (n) =>
  `Rs ${(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtDate = (d) =>
  d
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: CLINIC_TZ,
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date(d))
    : "";
const ymd = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ }).format(d).replace(/-/g, "");

// Stable, human-readable reference: patient + issue day (+ treatment when the
// invoice covers a single one).
export function invoiceNumber(client, treatmentId, issuedAt = new Date()) {
  const p = String(client._id).slice(-5).toUpperCase();
  const t = treatmentId ? `-${String(treatmentId).slice(-4).toUpperCase()}` : "";
  return `INV-${p}-${ymd(issuedAt)}${t}`;
}

export function invoiceFilename(client, number) {
  const name = String(client.name || "patient").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
  return `Invoice-${name}-${number}.pdf`;
}

const PRIMARY = "#0f766e";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const DANGER = "#b91c1c";

// Build the PDF and resolve with its bytes.
// doctor: clinic owner (User), client: patient (User), treatments: Treatment docs.
export function buildInvoicePdf({ doctor, client, treatments, number, issuedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Invoice ${number}` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ── Header: clinic on the left, invoice meta on the right ──
    const clinic = doctor.clinicName || `Dr. ${doctor.name}`;
    doc.fillColor(PRIMARY).font("Helvetica-Bold").fontSize(18).text(clinic, left, 48, { width: width * 0.6 });
    doc.fillColor("#111").font("Helvetica").fontSize(10);
    const clinicLines = [
      doctor.clinicName ? `Dr. ${doctor.name}` : "",
      doctor.specialization || "",
      doctor.address || [doctor.area, doctor.city].filter(Boolean).join(", "),
      [doctor.phone, doctor.email].filter(Boolean).join("  ·  "),
    ].filter(Boolean);
    for (const l of clinicLines) doc.fillColor(MUTED).text(l, { width: width * 0.6 });
    const headerBottom = doc.y;

    doc.fillColor("#111").font("Helvetica-Bold").fontSize(22).text("INVOICE", left, 48, { width, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED);
    doc.text(`No. ${number}`, { width, align: "right" });
    doc.text(`Date: ${fmtDate(issuedAt)}`, { width, align: "right" });

    let y = Math.max(headerBottom, doc.y) + 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
    y += 14;

    // ── Bill to ──
    doc.fillColor(MUTED).fontSize(9).font("Helvetica-Bold").text("BILL TO", left, y);
    doc.fillColor("#111").fontSize(12).font("Helvetica-Bold").text(client.name);
    doc.font("Helvetica").fontSize(10).fillColor(MUTED);
    if (client.managed) {
      if (client.guardianName) doc.text(`Guardian: ${client.guardianName}`);
      const c = [client.guardianPhone, client.guardianEmail].filter(Boolean).join("  ·  ");
      if (c) doc.text(c);
    } else {
      const c = [client.phone, client.email].filter(Boolean).join("  ·  ");
      if (c) doc.text(c);
      if (client.address) doc.text(client.address);
    }
    y = doc.y + 18;

    // ── Treatments table ──
    const cols = [
      { key: "date", label: "Date", w: 78, align: "left" },
      { key: "item", label: "Treatment", w: width - 78 - 3 * 82, align: "left" },
      { key: "cost", label: "Charges", w: 82, align: "right" },
      { key: "paid", label: "Paid", w: 82, align: "right" },
      { key: "bal", label: "Balance", w: 82, align: "right" },
    ];
    const pad = 6;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 40;

    const drawHeader = () => {
      doc.rect(left, y, width, 22).fill(PRIMARY);
      let x = left;
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9.5);
      for (const c of cols) {
        doc.text(c.label, x + pad, y + 7, { width: c.w - 2 * pad, align: c.align });
        x += c.w;
      }
      y += 22;
    };
    drawHeader();

    const rows = [...treatments].sort((a, b) => new Date(a.date) - new Date(b.date));
    rows.forEach((t, i) => {
      const detail = [t.site, t.diagnosis].filter(Boolean).join(" · ");
      doc.font("Helvetica").fontSize(10);
      const itemW = cols[1].w - 2 * pad;
      const h =
        Math.max(
          doc.heightOfString(t.procedure, { width: itemW }) +
            (detail ? doc.fontSize(8.5).heightOfString(detail, { width: itemW }) + 2 : 0),
          12
        ) + 12;
      if (y + h > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      if (i % 2 === 1) doc.rect(left, y, width, h).fill("#f9fafb");

      const vals = {
        date: fmtDate(t.date),
        cost: t.cost > 0 ? money(t.cost) : "No charge",
        paid: money(t.paidAmount),
        bal: money(t.balance),
      };
      let x = left;
      for (const c of cols) {
        if (c.key === "item") {
          doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text(t.procedure, x + pad, y + 6, { width: itemW });
          if (detail) doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(detail, { width: itemW });
        } else {
          doc
            .fillColor(c.key === "bal" && t.balance > 0 ? DANGER : "#111")
            .font("Helvetica")
            .fontSize(10)
            .text(vals[c.key], x + pad, y + 6, { width: c.w - 2 * pad, align: c.align });
        }
        x += c.w;
      }
      y += h;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(0.5).stroke();
    });

    // ── Totals ──
    const billed = rows.reduce((s, t) => s + (t.cost || 0), 0);
    const paid = rows.reduce((s, t) => s + (t.paidAmount || 0), 0);
    const due = Math.max(0, billed - paid);
    if (y + 80 > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    y += 12;
    const tx = right - 220;
    const totalRow = (label, value, bold, color = "#111") => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10).fillColor(color);
      doc.text(label, tx, y, { width: 110 });
      doc.text(value, tx + 110, y, { width: 110, align: "right" });
      y += bold ? 20 : 16;
    };
    totalRow("Total charges", money(billed));
    totalRow("Total paid", money(paid));
    doc.moveTo(tx, y - 2).lineTo(right, y - 2).strokeColor(BORDER).stroke();
    y += 4;
    totalRow("Balance due", money(due), true, due > 0 ? DANGER : PRIMARY);

    // ── Payment history ──
    const payments = rows
      .flatMap((t) => (t.payments || []).map((p) => ({ ...p.toObject?.() ?? p, procedure: t.procedure })))
      .filter((p) => p.amount)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (payments.length) {
      y += 16;
      if (y + 40 > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9).text("PAYMENT HISTORY", left, y);
      y = doc.y + 6;
      for (const p of payments) {
        if (y + 16 > bottomLimit) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        const method = p.method === "online" ? "Online" : p.method === "cash" ? "Cash" : "";
        const desc = [p.procedure, method, p.note].filter(Boolean).join("  ·  ");
        doc.fillColor("#111").font("Helvetica").fontSize(9.5);
        doc.text(fmtDate(p.date), left, y, { width: 78 });
        doc.fillColor(MUTED).text(desc, left + 78, y, { width: width - 78 - 100, lineBreak: false, ellipsis: true });
        doc.fillColor("#111").text(money(p.amount), right - 100, y, { width: 100, align: "right" });
        y += 15;
      }
    }

    // ── Footer ──
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(9)
      .text("Thank you for choosing us for your care.", left, doc.page.height - doc.page.margins.bottom - 14, {
        width,
        align: "center",
        lineBreak: false,
      });

    doc.end();
  });
}

// Plain-text version of the invoice for WhatsApp: a line per treatment plus the
// totals, so the patient sees what they owe without opening a file.
const MAX_TEXT_ROWS = 15;
export function buildInvoiceText({ doctor, client, treatments, number }) {
  const clinic = doctor.clinicName || `Dr. ${doctor.name}`;
  const greet = client.managed ? client.guardianName || "there" : client.name;
  const rows = [...treatments].sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
  const billed = rows.reduce((s, t) => s + (t.cost || 0), 0);
  const paid = rows.reduce((s, t) => s + (t.paidAmount || 0), 0);
  const due = Math.max(0, billed - paid);

  const lines = rows.slice(0, MAX_TEXT_ROWS).map(
    (t) =>
      `• ${fmtDate(t.date)} — ${t.procedure}: ` +
      (t.cost > 0 ? `${money(t.cost)} (paid ${money(t.paidAmount)})` : "No charge")
  );
  if (rows.length > MAX_TEXT_ROWS) lines.push(`…and ${rows.length - MAX_TEXT_ROWS} earlier treatment(s)`);

  return [
    `Hi ${greet},`,
    "",
    `Here is your invoice *${number}* from *${clinic}*${client.managed ? ` for ${client.name}` : ""}.`,
    "",
    ...lines,
    "",
    `Total charges: ${money(billed)}`,
    `Total paid: ${money(paid)}`,
    due > 0 ? `*Balance due: ${money(due)}*` : "*All charges are fully paid — thank you!*",
    "",
    `Regards,\n${clinic}`,
  ].join("\n");
}
