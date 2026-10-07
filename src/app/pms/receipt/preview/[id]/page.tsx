"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { renderReceiptA4Html } from "@/lib/receipt/printReceiptHtml";

export default function ReceiptPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        // Fetch receipt record
        const rcRes = await fetch(`/api/receipt/${id}`);
        const rcResult = await rcRes.json();
        if (!rcResult.success) throw new Error(rcResult.error || "Receipt not found");

        const receipt = rcResult.data;

        // Fetch seller info from hotel_settings via build-line-items (use any reservation)
        // We'll use the reservation_id stored in the receipt
        const sellerRes = await fetch(`/api/tax-invoice/build-line-items/${receipt.reservation_id}`);
        const sellerResult = await sellerRes.json();
        const seller = sellerResult?.seller_snapshot ?? {
          hotel_name: null,
          company_name: null,
          company_name_en: null,
          company_address: null,
          company_address_en: null,
          company_tax_id: null,
          company_phone: null,
        };

        // Also try to get checkin/checkout from booking_snapshot if available
        const bookingSnap = sellerResult?.data?.booking_snapshot ?? {};

        const rendered = renderReceiptA4Html({
          receiptNo: receipt.receipt_no,
          printedAt: receipt.printed_at || receipt.created_at,
          language: receipt.language || "th",
          guestName: receipt.guest_name,
          roomNumbers: Array.isArray(receipt.room_numbers) ? receipt.room_numbers : [],
          checkinDate: bookingSnap.checkin_date ?? null,
          checkoutDate: bookingSnap.checkout_date ?? null,
          grandTotal: Number(receipt.grand_total),
          note: receipt.note || null,
          seller,
        });
        setHtml(rendered);
      } catch (err: any) {
        setError(err.message || "Error loading receipt");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-20 animate-pulse text-[var(--text-muted)]">
      <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mb-4" />
      Generating Receipt...
    </div>
  );

  if (error || !html) return (
    <div className="max-w-md mx-auto py-20 text-center">
      <h2 className="text-lg font-bold">Preview Failed</h2>
      <p className="text-sm text-[var(--text-secondary)] mt-2">{error}</p>
      <button onClick={() => router.back()} className="mt-6 px-6 py-2 bg-emerald-600 text-white rounded-xl">Back</button>
    </div>
  );

  return (
    <div className="max-w-[1280px] mx-auto w-full pb-20">
      {/* Header bar */}
      <div className="flex items-center justify-between bg-[var(--bg-surface)] p-4 rounded-xl border border-[var(--border-default)] shadow-sm mb-6 sticky top-4 z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-[var(--bg-muted)] text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition"
          >
            ←
          </button>
          <div>
            <h1 className="text-sm font-bold text-[var(--text-primary)]">Receipt Preview</h1>
            <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-tight">🧾 Simple Receipt</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-[10px] text-amber-600 font-bold hidden md:block">⚠️ Margins: None · Scale: 100%</p>
          <button
            onClick={() => iframeRef.current?.contentWindow?.print()}
            className="px-8 py-2.5 rounded-xl bg-emerald-600 text-white font-extrabold text-sm shadow-lg hover:bg-emerald-700 transition flex items-center gap-2"
          >
            🖨️ Print Now
          </button>
        </div>
      </div>

      {/* A4 Frame */}
      <div className="flex justify-center bg-[var(--bg-muted)] p-8 rounded-2xl border border-[var(--border-default)] shadow-inner">
        <div className="bg-white shadow-2xl" style={{ width: "210mm", height: "297mm" }}>
          <iframe
            ref={iframeRef}
            srcDoc={html}
            className="w-full h-full border-none pointer-events-none"
            title="Receipt Preview"
          />
        </div>
      </div>
    </div>
  );
}
