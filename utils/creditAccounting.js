const DEBT_TOLERANCE = 0.009;
const ACCOUNTING_TIME_ZONE = "Africa/Johannesburg";

function calendarDateInAccountingZone(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACCOUNTING_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

function parsePaymentDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T12:00:00+02:00`);
  if (Number.isNaN(parsed.getTime()) || calendarDateInAccountingZone(parsed) !== text) return null;
  return { value: parsed, calendarDate: text };
}

function confirmedAmount(creditDetails = {}) {
  const payments = creditDetails.payments || [];
  const amount = payments.length
    ? payments.reduce((sum, payment) => sum + ((!payment.status || payment.status === "confirmed") ? Number(payment.amount || 0) : 0), 0)
    : Number(creditDetails.amountPaid || 0);
  return Math.round(amount * 100) / 100;
}

function normalizeCreditSaleDocument(sale) {
  if (sale?.paymentType !== "credit") return sale;
  const payments = sale.creditDetails?.payments || [];
  const amountPaid = confirmedAmount(sale.creditDetails);
  const pending = payments.length
    ? payments.reduce((sum, payment) => sum + (payment.status === "pending" ? Number(payment.amount || 0) : 0), 0)
    : Number(sale.creditDetails?.pendingAmount || 0);
  const amountDue = Math.max(0, Math.round((Number(sale.total || 0) - amountPaid) * 100) / 100);
  return { ...sale, creditDetails: { ...(sale.creditDetails || {}), payments, amountPaid, amountDue,
    pendingAmount: Math.round(pending * 100) / 100, fullyPaid: amountDue <= DEBT_TOLERANCE } };
}

module.exports = {
  ACCOUNTING_TIME_ZONE,
  DEBT_TOLERANCE,
  calendarDateInAccountingZone,
  confirmedAmount,
  normalizeCreditSaleDocument,
  parsePaymentDate,
};
