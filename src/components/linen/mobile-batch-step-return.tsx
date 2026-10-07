"use client";

import React, { useMemo, useState } from "react";
import useSWR from "@/hooks/use-simple-swr";
import { apiDataFetcher } from "@/lib/client/api-fetcher";
import { MobileItemRow } from "./mobile-item-row";
import type { LaundryRewashPendingResponse } from "@/lib/types";
import type { ReturnSummaryDisplayRow } from "@/lib/linen/rewash-summary";

interface ReturnItem {
    source_batch_id: string;
    source_business_date: string;
    source_pickup_round: number;
    linen_item_id: number;
    name_th?: string;
    remaining_qty: number;
    is_dayuse: boolean;
    // laneless. Required on purpose. Deployed out of order this fails loudly, instead of
    // quietly mis-laning every row into the collapsed accordion — which is the defect we are
    // fixing, wearing a different hat. Order is: migration ceremony first, app deploy second.
    lane: "recent" | "overdue";
}

interface MobileBatchStepReturnProps {
    batchId: string;
    items: any[];
    returnSources: ReturnItem[];
    initialReturnQtys?: Record<string, string>;
    onBack: () => void;
    onNext: (summary?: ReturnSummaryDisplayRow[], qtys?: Record<string, string>) => void;
}

export function MobileBatchStepReturn({ batchId, returnSources, initialReturnQtys, onBack, onNext }: MobileBatchStepReturnProps) {
    const [returnQtys, setReturnQtys] = useState<Record<string, string>>(initialReturnQtys || {});
    const [rewashQtys, setRewashQtys] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showOlderPending, setShowOlderPending] = useState(false);
    const [showPendingRewash, setShowPendingRewash] = useState(false);

    const { data: rwData, mutate: mutateRewash } = useSWR<LaundryRewashPendingResponse>("/api/linen/rewash/pending", apiDataFetcher);
    const pendingRewash = useMemo(
        () => (rwData?.events || []).filter((event) => String(event.sent_in_batch_id) !== String(batchId)),
        [batchId, rwData?.events]
    );

    const rewashPhotoSrc = (photoKeyOrUrl?: string | null) => {
        if (!photoKeyOrUrl) return null;
        if (/^https?:\/\//.test(photoKeyOrUrl) || photoKeyOrUrl.startsWith("blob:")) return photoKeyOrUrl;
        return `/api/linen/rewash/photo/${photoKeyOrUrl.split("/").map(encodeURIComponent).join("/")}`;
    };

    const { latestSources, olderSources, olderGroups } = useMemo(() => {
        const sorted = [...returnSources].sort((a, b) => {
            const dateCompare = String(b.source_business_date).localeCompare(String(a.source_business_date));
            if (dateCompare !== 0) return dateCompare;
            return Number(b.source_pickup_round) - Number(a.source_pickup_round);
        });
        // A1: consume the server's lane instead of re-deriving it. RULING 1 defines `recent` as
        // the newest (date, round) pair among the rows the server actually emits, current batch
        // excluded — a transcription of the derivation this replaces, so nothing staff-visible
        // moves. One definition, on the server. The sort stays: it sets display order, not lanes.
        const latestSources = sorted.filter((item) => item.lane === "recent");
        const olderSources = sorted.filter((item) => item.lane !== "recent");
        const olderGroups = olderSources.reduce<Record<string, ReturnItem[]>>((acc, item) => {
            const key = `${item.source_business_date} รอบ ${item.source_pickup_round}`;
            acc[key] = acc[key] || [];
            acc[key].push(item);
            return acc;
        }, {});
        return { latestSources, olderSources, olderGroups };
    }, [returnSources]);

    const handleQtyChange = (key: string, val: string) => {
        setReturnQtys(prev => ({ ...prev, [key]: val }));
    };

    const handleRewashQtyChange = (id: string, val: string, max: number) => {
        if (val === "") {
            setRewashQtys((prev) => ({ ...prev, [id]: "" }));
            return;
        }
        const parsed = parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > max) return;
        setRewashQtys((prev) => ({ ...prev, [id]: String(parsed) }));
    };

    const getPendingRewashReturns = () => pendingRewash
        .map((rw) => {
            const remainingQty = Math.max(0, Number((rw as any).remaining_qty ?? Number(rw.qty ?? 0) - Number(rw.resolved_qty ?? 0)));
            const qty = Math.min(remainingQty, Math.max(0, parseInt(rewashQtys[String(rw.id)] || "0", 10) || 0));
            return { id: String(rw.id), qty };
        })
        .filter((item) => item.qty > 0);

    const renderReturnRows = (sources: ReturnItem[]) => (
        <div className="divide-y divide-slate-100">
            {sources.map((source) => {
                const key = `${source.source_batch_id}_${source.linen_item_id}_${source.is_dayuse}`;
                return (
                    <MobileItemRow
                        key={key}
                        label={`${source.name_th ?? `Item ${source.linen_item_id}`}${source.is_dayuse ? " (Day Use)" : ""}`}
                        subLabel={`ส่งไป: ${source.remaining_qty}`}
                        value={returnQtys[key] ?? ""}
                        onChange={(val) => handleQtyChange(key, val)}
                        max={source.remaining_qty}
                        placeholder={String(source.remaining_qty)}
                    />
                );
            })}
        </div>
    );

    const handleSubmit = async () => {
        setIsSubmitting(true);
        try {
            // A2: rewash resolution rides inside the one step request instead of firing N
            // pre-step POSTs. One press = one commit; a failed submit now writes nothing, where
            // before it could leave rewash resolved with the batch not advanced. Sending both
            // would make the RPC reject the row as no longer pending, so the old calls are gone.
            const rewashResolved = getPendingRewashReturns().map((item) => ({
                rewash_event_id: Number(item.id),
                resolved_qty: item.qty,
            }));

            const items = returnSources.map(s => {
                const key = `${s.source_batch_id}_${s.linen_item_id}_${s.is_dayuse}`;
                return {
                    source_batch_id: s.source_batch_id,
                    linen_item_id: s.linen_item_id,
                    received_qty: parseInt(returnQtys[key] || "0", 10),
                    is_dayuse: s.is_dayuse,
                };
            });

            const res = await fetch(`/api/linen/batches/${batchId}/step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    step: "fo_return_counted",
                    return_items: items,
                    ...(rewashResolved.length > 0 ? { rewash_resolved: rewashResolved } : {}),
                }),
            });

            const result = await res.json().catch(() => null);
            if (!res.ok) throw new Error(result?.error || "Failed to submit returns");

            if (rewashResolved.length > 0) {
                setRewashQtys({});
                await mutateRewash();
            }
            const latestKeys = new Set(
                latestSources.map((source) => `${source.source_batch_id}_${source.linen_item_id}_${source.is_dayuse}`)
            );
            const summary = returnSources
                .map((source) => {
                    const key = `${source.source_batch_id}_${source.linen_item_id}_${source.is_dayuse}`;
                    return {
                        name: `${source.name_th ?? `Item ${source.linen_item_id}`}${source.is_dayuse ? " (Day Use)" : ""}`,
                        qty: parseInt(returnQtys[key] || "0", 10),
                        source: latestKeys.has(key) ? "normal" as const : "pending_resolved" as const,
                    };
                })
                .filter((item) => item.qty > 0);
            onNext(summary, returnQtys);
        } catch (error) {
            console.error(error);
            const message = error instanceof Error ? error.message : "Unknown error";
            alert(`เกิดข้อผิดพลาดในการบันทึก: ${message}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (returnSources.length === 0 && pendingRewash.length === 0) {
        return (
            <div className="flex flex-col h-[400px] justify-center items-center bg-white rounded-3xl p-8 text-center shadow-lg border border-slate-100">
                <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center text-slate-300 mb-6 border border-slate-100">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 shadow-sm">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                    </svg>
                </div>
                <h3 className="text-xl font-bold text-slate-800 font-thai mb-2">ไม่มีผ้ารอรับคืน</h3>
                <p className="text-sm text-slate-500 font-thai mb-8">ข้ามขั้นตอนนี้เพื่อไปหน้าถัดไป</p>
                <div className="grid w-full grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={onBack}
                        className="py-4 bg-slate-100 text-slate-700 font-bold rounded-2xl active:scale-95 transition-all border border-slate-200"
                    >
                        ย้อนกลับ
                    </button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={isSubmitting}
                        className="py-4 bg-[#1B4038] text-white font-bold rounded-2xl shadow-lg active:scale-95 transition-all"
                    >
                        {isSubmitting ? "กำลังบันทึก..." : "ถัดไป"}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-white rounded-3xl shadow-lg border border-slate-100 overflow-hidden mb-24">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-bold text-slate-900 font-thai">2. นับผ้ารับคืน</h2>
                    <p className="text-sm text-slate-500 font-thai">รับคืนจากร้านซักรีด</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-5">
                    {latestSources.length > 0 && (
                        <section>
                            <div className="mb-3 flex items-center justify-between">
                                <div>
                                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">รอบล่าสุด</p>
                                    <h3 className="mt-1 text-lg font-black text-slate-900 font-thai">
                                        คืนจาก {latestSources[0]?.source_business_date} รอบ {latestSources[0]?.source_pickup_round}
                                    </h3>
                                </div>
                                <div className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-[#1B4038]">
                                    {latestSources.length} รายการ
                                </div>
                            </div>
                            {renderReturnRows(latestSources)}
                        </section>
                    )}

                    {olderSources.length > 0 && (
                        <section className="pt-2">
                            <button
                                type="button"
                                onClick={() => setShowOlderPending((value) => !value)}
                                className="flex w-full items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-left active:scale-[0.99] transition-all"
                            >
                                <div>
                                    <p className="text-sm font-black text-amber-900 font-thai">เลือกผ้าค้างเก่า</p>
                                    <p className="mt-0.5 text-xs font-medium text-amber-700/70 font-thai">
                                        มี {olderSources.length} รายการจาก batch ก่อนหน้า
                                    </p>
                                </div>
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    className={`h-5 w-5 text-amber-700 transition-transform ${showOlderPending ? "rotate-180" : ""}`}
                                >
                                    <path d="m6 9 6 6 6-6" />
                                </svg>
                            </button>

                            {showOlderPending && (
                                <div className="mt-4 space-y-5 rounded-3xl border border-slate-100 bg-slate-50/70 p-4">
                                    {Object.entries(olderGroups).map(([groupLabel, sources]) => (
                                        <div key={groupLabel}>
                                            <div className="mb-2 flex items-center gap-2">
                                                <div className="h-4 w-1 rounded-full bg-amber-400" />
                                                <span className="text-xs font-black uppercase tracking-widest text-amber-700">
                                                    คืนจาก {groupLabel}
                                                </span>
                                            </div>
                                            <div className="rounded-2xl bg-white px-2">
                                                {renderReturnRows(sources)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}

                    {/* Pending Rewash Section */}
                    {pendingRewash && pendingRewash.length > 0 && (
                        <section className="pt-2">
                            <button
                                type="button"
                                onClick={() => setShowPendingRewash((value) => !value)}
                                className="flex w-full items-center justify-between rounded-2xl border border-purple-200 bg-purple-50 px-4 py-4 text-left active:scale-[0.99] transition-all"
                            >
                                <div>
                                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-purple-500">ค้างส่งซักใหม่</p>
                                    <p className="mt-1 text-lg font-black text-slate-900 font-thai">ผ้า Rewash ที่รอคืน</p>
                                    <p className="mt-0.5 text-xs font-medium text-purple-700/70 font-thai">
                                        มี {pendingRewash.length} รายการ รอคืนจากร้านซัก
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="rounded-full bg-white px-3 py-1 text-xs font-bold text-purple-700 border border-purple-200">
                                        {pendingRewash.length} รายการ
                                    </div>
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.5"
                                        className={`h-5 w-5 text-purple-700 transition-transform ${showPendingRewash ? "rotate-180" : ""}`}
                                    >
                                        <path d="m6 9 6 6 6-6" />
                                    </svg>
                                </div>
                            </button>

                            {showPendingRewash && (
                                <div className="mt-4 space-y-3 rounded-3xl border border-purple-100 bg-purple-50/60 p-4">
                                    {pendingRewash.map((rw) => {
                                        const photoKey = (rw as any).photo_keys?.[0] ?? (rw as any).photo_urls?.[0];
                                        const photoSrc = rewashPhotoSrc(photoKey);
                                        const remainingQty = Math.max(0, Number((rw as any).remaining_qty ?? Number(rw.qty ?? 0) - Number(rw.resolved_qty ?? 0)));
                                        const typedQty = rewashQtys[String(rw.id)] ?? "";
                                        const submitQty = Math.min(remainingQty, Math.max(0, parseInt(typedQty || "0", 10) || 0));
                                        return (
                                            <div key={rw.id} className="bg-purple-50 border border-purple-100 rounded-2xl p-4 group">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="flex items-center gap-3 min-w-0">
                                                        <div className="w-12 h-12 rounded-lg bg-white border border-purple-200 flex items-center justify-center overflow-hidden shrink-0">
                                                            {photoSrc ? (
                                                                <img src={photoSrc} alt="Proof" className="w-full h-full object-cover" />
                                                            ) : (
                                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6 text-purple-200"><path d="M12 5v14M5 12h14"/></svg>
                                                            )}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="font-bold text-slate-900 font-thai">{rw.item_name_th}</p>
                                                            <p className="text-[10px] text-slate-500 font-thai">คงเหลือ {remainingQty} / ทั้งหมด {rw.qty} • จากรอบ {rw.sent_batch_pickup_round}</p>
                                                            {Number(rw.resolved_qty ?? 0) > 0 && (
                                                                <p className="text-[10px] text-purple-600 font-thai">คืนแล้วสะสม {rw.resolved_qty} ชิ้น</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRewashQtys((prev) => ({ ...prev, [String(rw.id)]: String(remainingQty) }))}
                                                        className="shrink-0 rounded-xl border border-purple-200 bg-white px-3 py-2 text-xs font-bold text-purple-700 active:scale-95"
                                                    >
                                                        เต็ม
                                                    </button>
                                                </div>
                                                <div className="mt-3 flex items-center gap-2">
                                                    <div className="flex items-center gap-1 rounded-2xl border border-purple-100 bg-white p-1.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRewashQtyChange(String(rw.id), String(Math.max(0, submitQty - 1)), remainingQty)}
                                                            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-600 active:scale-90"
                                                        >
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5"><path d="M5 12h14" /></svg>
                                                        </button>
                                                        <input
                                                            type="number"
                                                            inputMode="numeric"
                                                            pattern="[0-9]*"
                                                            min={0}
                                                            max={remainingQty}
                                                            value={typedQty}
                                                            placeholder={String(remainingQty)}
                                                            onChange={(e) => handleRewashQtyChange(String(rw.id), e.target.value, remainingQty)}
                                                            className="w-14 border-0 bg-transparent text-center text-xl font-black text-purple-700 focus:ring-0 placeholder:text-purple-200"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRewashQtyChange(String(rw.id), String(Math.min(remainingQty, submitQty + 1)), remainingQty)}
                                                            className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-600 text-white active:scale-90"
                                                        >
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-5 h-5"><path d="M12 5v14M5 12h14" /></svg>
                                                        </button>
                                                    </div>
                                                    <div className="flex-1 rounded-xl border border-purple-100 bg-white px-4 py-3 text-center text-xs font-bold text-purple-600">
                                                        บันทึกเมื่อกดถัดไป
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}
                </div>
            </div>

            <div className="p-5 bg-white border-t border-slate-100 fixed bottom-0 left-0 right-0 max-w-lg mx-auto z-40 shadow-[0_-5px_20px_rgba(0,0,0,0.03)] grid grid-cols-2 gap-3">
                <button
                    type="button"
                    onClick={onBack}
                    disabled={isSubmitting}
                    className="py-4 bg-slate-100 text-slate-700 font-bold rounded-2xl active:scale-95 transition-all text-base border border-slate-200"
                >
                    ย้อนกลับ
                </button>
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="py-4 bg-[#1B4038] text-white font-bold rounded-2xl shadow-lg active:scale-95 transition-all text-base flex justify-center items-center gap-2"
                >
                    {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <>ถัดไป <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5"><path d="M5 12h14M12 5l7 7-7 7" /></svg></>}
                </button>
            </div>
        </div>
    );
}
