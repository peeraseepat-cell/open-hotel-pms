"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import TaxInvoiceForm from "../../tax-invoice-form";
import { BuildLineItemsResult, TaxInvoiceLineItem } from "@/lib/tax-invoice/types";
import { pickEditSeedLineItems } from "@/lib/tax-invoice/edit-seed";

type AuditHistoryRow = {
  id: string;
  actor_name: string;
  action: string;
  note: string | null;
  business_date: string;
  created_at: string;
  before_json: any;
  after_json: any;
};

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function getLineItemPeriod(lineItems: TaxInvoiceLineItem[], fallbackFrom: string, fallbackTo: string) {
  const stayDates = Array.from(
    new Set(
      (lineItems || [])
        .filter((item) => item.kind === "room_charge")
        .flatMap((item) => item.stay_dates ?? [])
    )
  ).sort();

  return {
    from: stayDates[0] ?? fallbackFrom,
    to: stayDates.length > 0 ? addDays(stayDates[stayDates.length - 1], 1) : fallbackTo,
  };
}

function formatDateTime(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAmount(value: unknown) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function summarizeAuditChange(row: AuditHistoryRow) {
  const before = row.before_json || {};
  const after = row.after_json || {};
  const changes: string[] = [];

  if (before.language !== after.language) changes.push(`Language ${before.language || "-"} -> ${after.language || "-"}`);
  if (before.customer_name !== after.customer_name) changes.push("Customer name");
  if (before.customer_tax_id !== after.customer_tax_id) changes.push("Tax ID");
  if (before.customer_address !== after.customer_address) changes.push("Address");
  if (before.customer_branch !== after.customer_branch) changes.push("Branch");
  if (Number(before.grand_total || 0) !== Number(after.grand_total || 0)) {
    changes.push(`Total ${formatAmount(before.grand_total)} -> ${formatAmount(after.grand_total)}`);
  }
  const beforeItems = Array.isArray(before.line_items) ? before.line_items.length : 0;
  const afterItems = Array.isArray(after.line_items) ? after.line_items.length : 0;
  if (beforeItems !== afterItems) changes.push(`Items ${beforeItems} -> ${afterItems}`);

  return changes.length > 0 ? changes.join(" · ") : "Document fields updated";
}

function EditInvoiceLog({ rows }: { rows: AuditHistoryRow[] }) {
  return (
    <section className="mt-8 bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] shadow-sm overflow-hidden">
      <div className="px-5 py-4 bg-[var(--bg-muted)] border-b border-[var(--border-default)] flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-[var(--text-primary)]">Edit Invoice Log</h2>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Admin only audit trail</p>
        </div>
        <span className="text-[10px] font-bold text-[var(--text-muted)]">{rows.length} records</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-[var(--text-muted)] italic">No edit logs for this invoice yet.</div>
      ) : (
        <div className="divide-y divide-[var(--border-subtle)]">
          {rows.map((row) => (
            <div key={row.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold text-[var(--text-primary)]">{summarizeAuditChange(row)}</p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    {row.note ? row.note : "No reason provided"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-semibold text-[var(--text-primary)]">{row.actor_name || "System"}</p>
                  <p className="text-[10px] text-[var(--text-muted)]">{formatDateTime(row.created_at)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function TaxInvoiceEditPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [fullBuildData, setFullBuildData] = useState<BuildLineItemsResult | null>(null);
  const [auditHistory, setAuditHistory] = useState<AuditHistoryRow[]>([]);
  const [showAuditHistory, setShowAuditHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewerIsAdmin, setViewerIsAdmin] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(`/api/tax-invoice/${id}`, { cache: "no-store" });
        const result = await res.json();
        if (result.success) {
          const invoice = result.data;
          setData(invoice);
          setViewerIsAdmin(Boolean(result.viewer_is_admin));

          if (invoice?.reservation_id) {
            const reservationIds = Array.isArray(invoice.booking_snapshot?.reservation_ids)
              ? invoice.booking_snapshot.reservation_ids.filter(Boolean)
              : [];
            const extraIds = reservationIds.filter((reservationId: string) => reservationId !== invoice.reservation_id);
            const query = extraIds.length > 0
              ? `?reservation_ids=${encodeURIComponent(extraIds.join(","))}`
              : "";
            const fullRes = await fetch(`/api/tax-invoice/build-line-items/${invoice.reservation_id}${query}`, { cache: "no-store" });
            const fullResult = await fullRes.json();
            if (fullRes.ok && fullResult.success) {
              setFullBuildData(fullResult.data);
            }
          }

          const auditRes = await fetch(`/api/audit/entity/tax_invoice/${id}`, { cache: "no-store" });
          if (auditRes.ok) {
            const auditResult = await auditRes.json();
            if (auditResult.success && Array.isArray(auditResult.history)) {
              setAuditHistory(auditResult.history);
              setShowAuditHistory(true);
            }
          }
        } else {
          setError(result.error || "Invoice not found");
        }
      } catch (e) {
        setError("Error fetching invoice data");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-20 animate-pulse text-[var(--text-muted)]">
      <div className="w-12 h-12 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin mb-4" />
      Loading Invoice Detail...
    </div>
  );

  if (error || !data) return (
    <div className="max-w-md mx-auto py-20 text-center">
      <h2 className="text-lg font-bold">Edit Failed</h2>
      <p className="text-sm text-[var(--text-secondary)] mt-2">{error}</p>
      <button onClick={() => router.back()} className="mt-6 px-6 py-2 bg-brand-600 text-white rounded-xl">Back</button>
    </div>
  );

  if (data.invoice_kind && data.invoice_kind !== "standard" && !viewerIsAdmin) {
    return (
      <div className="max-w-md mx-auto py-20 text-center">
        <h2 className="text-lg font-bold">Edit Not Allowed</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-2">
          FO can preview and print split invoices, but only Admin can edit them.
        </p>
        <button onClick={() => router.push(`/pms/tax-invoice/preview/${id}`)} className="mt-6 px-6 py-2 bg-brand-600 text-white rounded-xl">Open Preview</button>
      </div>
    );
  }

  // Map invoice data to the form expected format
  const fullSnapshot = fullBuildData?.booking_snapshot ?? data.booking_snapshot;
  const fullReservation = fullBuildData?.reservation;
  const initialPeriod = getLineItemPeriod(
    data.line_items || [],
    fullSnapshot.checkin_date,
    fullSnapshot.checkout_date
  );
  const formInitialData: BuildLineItemsResult = {
    reservation: {
      id: data.reservation_id,
      reservation_ids: Array.isArray(data.booking_snapshot?.reservation_ids)
        ? data.booking_snapshot.reservation_ids
        : [data.reservation_id],
      booking_code: fullReservation?.booking_code ?? fullSnapshot.booking_code,
      guest_name: data.customer_name,
      source: fullReservation?.source ?? fullSnapshot.source,
      checkin_date: fullReservation?.checkin_date ?? fullSnapshot.checkin_date,
      checkout_date: fullReservation?.checkout_date ?? fullSnapshot.checkout_date,
      tax_invoice_requested: true,
      guest_profile_id: data.guest_tax_profile_id,
    },
    line_items: pickEditSeedLineItems({
      saved: data.line_items,
      rebuilt: fullBuildData?.line_items,
      invoiceKind: data.invoice_kind,
    }),
    available_extra_items: fullBuildData?.available_extra_items ?? [],
    totals: {
      subtotal: data.subtotal,
      vat_rate: data.vat_rate,
      vat_amount: data.vat_amount,
      grand_total: data.grand_total,
      discount: data.discount,
    },
    booking_snapshot: fullSnapshot,
  };

  return (
    <div className="max-w-[1280px] mx-auto w-full pb-20">
      <div className="mb-6 flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Edit Tax Invoice</h1>
          <p className="text-sm text-[var(--text-secondary)]">Modifying {data.invoice_no}</p>
        </div>
        
        {data.status === "issued" && (
          <div className="px-3 py-1 rounded bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-[10px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-tight">
            Issued · Admin Edit Required after Night Audit
          </div>
        )}
      </div>
      
      <TaxInvoiceForm
        initialData={formInitialData}
        invoiceId={id}
        mode="edit"
        reservationId={data.reservation_id}
        existingInvoice={{
          language: data.language,
          customer_name: data.customer_name,
          customer_tax_id: data.customer_tax_id,
          customer_address: data.customer_address,
          customer_branch: data.customer_branch,
          remark: data.remark,
          issue_date: data.issue_date,
          invoice_kind: data.invoice_kind,
          coverage_amount: data.coverage_amount,
          coverage_note: data.coverage_note,
          manual_issue_date_reason: data.manual_issue_date_reason,
        }}
        initialPeriod={initialPeriod}
        viewerIsAdmin={viewerIsAdmin}
        businessDate={data.issue_date}
      />
      {showAuditHistory && <EditInvoiceLog rows={auditHistory} />}
    </div>
  );
}
