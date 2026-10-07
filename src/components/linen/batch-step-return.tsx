"use client";

import React, { useState, useMemo } from "react";
import useSWR from "@/hooks/use-simple-swr";
import type { LaundryBatchItem, LaundryPendingItem, LaundryReturnSourceItem } from "@/lib/types";
import type { LaundryRewashPendingResponse } from "@/lib/types";
import { apiDataFetcher } from "@/lib/client/api-fetcher";
import type { ReturnSummaryDisplayRow } from "@/lib/linen/rewash-summary";
import { sortReturnSourcesForDisplay } from "@/lib/linen/return-display-order";
import { dropPendingResolvedCoveredByReturns } from "@/lib/linen/pending-resolve-overlap";

interface BatchStepReturnProps {
    batchId: string;
    items: LaundryBatchItem[];
    returnSources?: LaundryReturnSourceItem[];
    onNext: (summary?: ReturnSummaryDisplayRow[]) => void;
}

export function BatchStepReturn({ batchId, items, returnSources = [], onNext }: BatchStepReturnProps) {
    const { data: pendingItems, isLoading: isPendingLoading } = useSWR<LaundryPendingItem[]>("/api/linen/pending", apiDataFetcher);
    const { data: rwData, mutate: mutateRewash } = useSWR<LaundryRewashPendingResponse>("/api/linen/rewash/pending", apiDataFetcher);
    const [returnData, setReturnData] = useState<Record<string, string>>({});
    const [resolvedPending, setResolvedPending] = useState<string[]>([]);
    const [rewashQtys, setRewashQtys] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isPendingSheetOpen, setIsPendingSheetOpen] = useState(false);
    const [isRewashSheetOpen, setIsRewashSheetOpen] = useState(false);
    const [isResolvingRewash, setIsResolvingRewash] = useState<Record<string, boolean>>({});

    const pendingRewash = useMemo(
        () => (rwData?.events || []).filter((event) => String(event.sent_in_batch_id) !== String(batchId)),
        [batchId, rwData?.events]
    );

    // Group pending items by date
    const pendingByDate = useMemo(() => {
        if (!pendingItems) return {};
        const map: Record<string, LaundryPendingItem[]> = {};
        pendingItems.forEach(pi => {
            const date = pi.source_batch_date || pi.created_at.split("T")[0];
            if (!map[date]) map[date] = [];
            map[date].push(pi);
        });
        return map;
    }, [pendingItems]);

    const hasPending = pendingItems && pendingItems.length > 0;

    const rewashPhotoSrc = (photoKeyOrUrl?: string | null) => {
        if (!photoKeyOrUrl) return null;
        if (/^https?:\/\//.test(photoKeyOrUrl) || photoKeyOrUrl.startsWith("blob:")) return photoKeyOrUrl;
        return `/api/linen/rewash/photo/${photoKeyOrUrl.split("/").map(encodeURIComponent).join("/")}`;
    };

    // A1 moved this list off a server query that sorted ascending (date, round) and
    // onto fn_laundry_return_partition, which emits lane_order + date/round DESC.
    // This screen renders the payload in payload order, so the list silently
    // reversed. Restore the legacy order here — one order-sensitive consumer, and
    const orderedReturnSources = useMemo(() => sortReturnSourcesForDisplay(returnSources), [returnSources]);

    const isComplete = useMemo(() => {
        // all source items expected back MUST have an entry in returnData (can be 0)
        for (const item of returnSources) {
            if (returnData[item.id] === undefined || returnData[item.id] === "") {
                return false;
            }
        }
        return true;
    }, [returnSources, returnData]);

    const handleReturnChange = (id: string, val: string) => {
        setReturnData(prev => ({ ...prev, [id]: val }));
    };

    const toggleResolvePending = (id: string) => {
        setResolvedPending(prev => 
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        );
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

    const handleResolveRewash = async (id: string, qty: number) => {
        setIsResolvingRewash((prev) => ({ ...prev, [id]: true }));
        try {
            const res = await fetch(`/api/linen/rewash/${id}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    resolved_in_batch_id: batchId,
                    resolved_qty: qty,
                }),
            });
            if (!res.ok) throw new Error("Failed to resolve rewash");
            setRewashQtys((prev) => ({ ...prev, [id]: "" }));
            await mutateRewash();
        } catch (error) {
            console.error(error);
            alert("เกิดข้อผิดพลาดในการบันทึกรับผ้า Rewash");
        } finally {
            setIsResolvingRewash((prev) => ({ ...prev, [id]: false }));
        }
    };

    const getPendingRewashReturns = () => pendingRewash
        .map((rw) => {
            const remainingQty = Math.max(
                0,
                Number((rw as any).remaining_qty ?? Number(rw.qty ?? 0) - Number(rw.resolved_qty ?? 0))
            );
            const qty = Math.min(remainingQty, Math.max(0, parseInt(rewashQtys[String(rw.id)] || "0", 10) || 0));
            return { id: String(rw.id), qty };
        })
        .filter((item) => item.qty > 0);

    const resolveTypedRewashReturns = async () => {
        const rewashReturns = getPendingRewashReturns();
        if (rewashReturns.length === 0) return;

        await Promise.all(rewashReturns.map(async (item) => {
            setIsResolvingRewash((prev) => ({ ...prev, [item.id]: true }));
            const res = await fetch(`/api/linen/rewash/${item.id}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    resolved_in_batch_id: batchId,
                    resolved_qty: item.qty,
                }),
            });
            const result = await res.json().catch(() => null);
            if (!res.ok || result?.success === false) {
                throw new Error(result?.error || "Failed to resolve rewash");
            }
        }));

        setRewashQtys((prev) => {
            const next = { ...prev };
            for (const item of rewashReturns) delete next[item.id];
            return next;
        });
        await mutateRewash();
    };

    const handleSubmit = async () => {
        if (!isComplete) return;
        setIsSubmitting(true);
        try {
            await resolveTypedRewashReturns();

            // ordered, not raw: this array becomes the stored fo_return_counted event,
            // and toReturnSummaryRows reads the LINE text's row order from that event.
            const returnItemsPayload = orderedReturnSources.map(item => ({
                source_batch_id: item.source_batch_id,
                linen_item_id: item.linen_item_id,
                received_qty: parseInt(returnData[item.id] || "0", 10),
                is_dayuse: item.is_dayuse,
            }));

            // F1: legacy ran the two passes sequentially — the return_items pass closed
            // the marker, then resolvePendingItems looked it up with resolved_at is null,
            // found nothing and hit `if (!pending) continue` (pending-service.ts:220).
            // A silent skip; the press succeeded. The atomic RPC rejects the same overlap
            // with 22023 and rolls the whole press back, so a press that worked yesterday
            // stops working. Restore the legacy outcome by not sending the marker.
            const safePendingResolved = dropPendingResolvedCoveredByReturns(
                resolvedPending,
                returnItemsPayload,
                pendingItems ?? []
            );

            const payload = {
                step: "fo_return_counted",
                return_items: returnItemsPayload,
                pending_resolved: safePendingResolved.map(id => ({ pending_item_id: id }))
            };

            const res = await fetch(`/api/linen/batches/${batchId}/step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("Failed to submit return counts");
            const returnedSummary: ReturnSummaryDisplayRow[] = orderedReturnSources
                .map((item) => ({
                    name: item.name_th ?? `Item ${item.linen_item_id}`,
                    qty: parseInt(returnData[item.id] || "0", 10),
                    source: "normal" as const,
                }))
                .filter((item) => item.qty > 0);
            const pendingSummary: ReturnSummaryDisplayRow[] = (pendingItems ?? [])
                .filter((item) => resolvedPending.includes(item.id))
                .map((item) => ({
                    name: item.name_th ?? `Item ${item.linen_item_id}`,
                    qty: Number(item.pending_qty ?? 0),
                    source: "pending_resolved" as const,
                }))
                .filter((item) => item.qty > 0);
            onNext([...returnedSummary, ...pendingSummary]);
        } catch (error) {
            console.error(error);
            alert("เกิดข้อผิดพลาดในการบันทึก กรุณาลองใหม่");
        } finally {
            setIsSubmitting(false);
            setIsResolvingRewash({});
        }
    };

    const displayItems = useMemo(() => {
        return orderedReturnSources.map(i => ({
            id: i.id,
            name: i.name_th || `Item ${i.linen_item_id}`,
            sent: i.remaining_qty,
            sourceLabel: `${i.source_business_date} #${i.source_pickup_round}`,
        }));
    }, [orderedReturnSources]);

    return (
        <div className="w-full relative">
            <div className="bg-white dark:bg-slate-900 rounded-t-xl rounded-b sm:rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm transition-colors">
                <div className="p-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
                    <div>
                        <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-lg flex items-center gap-2">
                            <span>📋 นับผ้ารับคืน</span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold uppercase transition-colors">Step 2/4</span>
                        </h3>
                    </div>
                </div>

                <div className="p-4 bg-white dark:bg-slate-900">
                    <h4 className="font-semibold text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2 text-sm">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full" />
                        คืนจากการส่งรอบที่ผ่านมา
                    </h4>

                    {displayItems.length === 0 ? (
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl text-center text-slate-500 dark:text-slate-400 text-sm mb-6 border border-dashed border-slate-200 dark:border-slate-700">
                            ไม่มีผ้าที่ต้องรับคืนจากรอบก่อนหน้า
                        </div>
                    ) : (
                        <>
                            <div className="flex text-[10px] font-bold text-slate-400 dark:text-slate-500 px-2 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800 uppercase tracking-widest">
                                <div className="flex-1">รายการ</div>
                                <div className="w-16 text-center">ส่งไป</div>
                                <div className="w-20 text-center">รับจริง</div>
                            </div>

                            <div className="space-y-3 mb-6">
                                {displayItems.map(item => (
                                    <div key={item.id} className="flex items-center gap-2">
                                        <div className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300 pl-2">
                                            {item.name}
                                            <span className="block text-[10px] text-slate-400 dark:text-slate-500 font-normal uppercase tracking-tight">รอบ {item.sourceLabel}</span>
                                        </div>
                                        <div className="w-16 text-center text-sm font-medium text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 py-1.5 rounded-md">
                                            {item.sent}
                                        </div>
                                        <div className="w-20">
                                            <input
                                                type="number"
                                                min="0"
                                                value={returnData[item.id] ?? ""}
                                                onChange={(e) => handleReturnChange(item.id, e.target.value)}
                                                className="w-full h-11 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-lg text-center font-bold text-slate-800 dark:text-slate-100 text-lg transition-all focus:border-[#1B4038] focus:ring-4 focus:ring-[#1B4038]/10 outline-none"
                                                placeholder="..."
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    {isPendingLoading ? (
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl text-center text-slate-400 animate-pulse text-sm">กำลังโหลดข้อมูลผ้าค้าง...</div>
                    ) : hasPending ? (
                        <div className="mt-6 border border-amber-200 dark:border-amber-900/50 rounded-xl overflow-hidden bg-amber-50/30 dark:bg-amber-950/20">
                            <div className="p-4 border-b border-amber-100 dark:border-amber-900/50 flex items-center justify-between">
                                <h4 className="font-semibold text-amber-800 dark:text-amber-400 flex items-center gap-2 text-sm">
                                    <div className="w-2 h-2 bg-amber-500 rounded-full" />
                                    ผ้าค้างเก่า ({pendingItems.length} รายการ)
                                </h4>
                                <button 
                                    onClick={() => setIsPendingSheetOpen(!isPendingSheetOpen)}
                                    className="text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/50 hover:bg-amber-200 dark:hover:bg-amber-900 px-3 py-1.5 rounded-lg transition-colors shadow-sm uppercase tracking-wider"
                                >
                                    {isPendingSheetOpen ? 'ปิดรายละเอียด' : 'ดูรายละเอียด →'}
                                </button>
                            </div>
                            
                            {isPendingSheetOpen && (
                                <div className="p-3 bg-white dark:bg-slate-900 space-y-4">
                                    {Object.entries(pendingByDate).map(([date, pItems]) => (
                                        <div key={date}>
                                            <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 mb-2 px-1 uppercase tracking-tight">รอบวันที่ {date}</div>
                                            <div className="space-y-2">
                                                {pItems.map(pi => {
                                                    const isResolved = resolvedPending.includes(pi.id);
                                                    return (
                                                        <label 
                                                            key={pi.id} 
                                                            className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all select-none
                                                                ${isResolved 
                                                                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20' 
                                                                    : 'border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-amber-300 dark:hover:border-amber-700'}`}
                                                        >
                                                            <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 border-2 transition-colors
                                                                ${isResolved 
                                                                    ? 'bg-emerald-500 border-emerald-500 text-white' 
                                                                    : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-transparent'}`}
                                                            >
                                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-4 h-4"><polyline points="20 6 9 17 4 12"/></svg>
                                                            </div>
                                                            <div className="flex-1 flex justify-between items-center">
                                                                <span className={`text-sm font-medium ${isResolved ? 'text-emerald-800 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-300'}`}>{pi.name_th}</span>
                                                                <span className={`text-sm font-bold ${isResolved ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-500'}`}>{pi.pending_qty} ชิ้น</span>
                                                            </div>
                                                            <input 
                                                                type="checkbox" 
                                                                className="hidden"
                                                                checked={isResolved}
                                                                onChange={() => toggleResolvePending(pi.id)}
                                                            />
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="mt-6 border border-slate-200 dark:border-slate-800 rounded-xl p-4 bg-slate-50 dark:bg-slate-800/30 text-center text-sm text-slate-500 dark:text-slate-400 flex flex-col items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-600">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                            </div>
                            ไม่มีผ้าค้างเก่า
                        </div>
                    )}

                    {pendingRewash.length > 0 && (
                        <div className="mt-6 border border-purple-200 dark:border-purple-900/50 rounded-xl overflow-hidden bg-purple-50/40 dark:bg-purple-950/20">
                            <div className="p-4 border-b border-purple-100 dark:border-purple-900/50 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 bg-purple-500 rounded-full" />
                                    <div>
                                        <h4 className="font-semibold text-purple-800 dark:text-purple-400 text-sm">
                                            ผ้าซักใหม่ที่รอคืน ({pendingRewash.length} รายการ)
                                        </h4>
                                        <p className="text-[11px] text-purple-700/70 dark:text-purple-400/70">
                                            ซ่อนไว้ก่อน เพราะบางรายการรอคืนหลายวัน
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setIsRewashSheetOpen((prev) => !prev)}
                                    className="text-[10px] font-bold text-purple-700 dark:text-purple-300 bg-white dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/60 border border-purple-200 dark:border-purple-800 px-3 py-1.5 rounded-lg transition-colors shadow-sm uppercase tracking-wider"
                                >
                                    {isRewashSheetOpen ? "ปิดรายละเอียด" : "ดูรายละเอียด →"}
                                </button>
                            </div>

                            {isRewashSheetOpen && (
                                <div className="p-4 bg-white dark:bg-slate-900 space-y-3">
                                    {pendingRewash.map((rw) => {
                                        const photoKey = (rw as any).photo_keys?.[0] ?? (rw as any).photo_urls?.[0];
                                        const photoSrc = rewashPhotoSrc(photoKey);
                                        const remainingQty = Math.max(
                                            0,
                                            Number((rw as any).remaining_qty ?? Number(rw.qty ?? 0) - Number(rw.resolved_qty ?? 0))
                                        );
                                        const typedQty = rewashQtys[String(rw.id)] ?? "";
                                        const submitQty = Math.min(remainingQty, Math.max(0, parseInt(typedQty || "0", 10) || 0));

                                        return (
                                            <div key={rw.id} className="rounded-xl border border-purple-100 dark:border-purple-900/40 bg-purple-50 dark:bg-purple-950/20 p-3">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="flex items-center gap-3 min-w-0">
                                                        <div className="w-12 h-12 rounded-lg bg-white dark:bg-slate-800 border border-purple-200 dark:border-purple-800 flex items-center justify-center overflow-hidden shrink-0">
                                                            {photoSrc ? (
                                                                <img src={photoSrc} alt="Rewash proof" className="w-full h-full object-cover" />
                                                            ) : (
                                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6 text-purple-200"><path d="M12 5v14M5 12h14"/></svg>
                                                            )}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="font-semibold text-slate-900 dark:text-slate-100">{rw.item_name_th}</p>
                                                            <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                                                คงเหลือ {remainingQty} / ทั้งหมด {rw.qty} • จากรอบ {rw.sent_batch_pickup_round}
                                                            </p>
                                                            {Number(rw.resolved_qty ?? 0) > 0 && (
                                                                <p className="text-[11px] text-purple-600 dark:text-purple-400">
                                                                    คืนแล้วสะสม {rw.resolved_qty} ชิ้น
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRewashQtys((prev) => ({ ...prev, [String(rw.id)]: String(remainingQty) }))}
                                                        className="shrink-0 rounded-lg border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-bold text-purple-700 dark:text-purple-300"
                                                    >
                                                        เต็ม
                                                    </button>
                                                </div>

                                                <div className="mt-3 flex items-center gap-2">
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        max={remainingQty}
                                                        value={typedQty}
                                                        onChange={(e) => handleRewashQtyChange(String(rw.id), e.target.value, remainingQty)}
                                                        placeholder={String(remainingQty)}
                                                        className="w-24 h-11 bg-white dark:bg-slate-800 border-2 border-purple-200 dark:border-purple-800 rounded-lg text-center font-bold text-purple-700 dark:text-purple-300 text-lg outline-none"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => handleResolveRewash(String(rw.id), submitQty)}
                                                        disabled={isResolvingRewash[String(rw.id)] || submitQty <= 0}
                                                        className={`flex-1 h-11 rounded-lg font-bold text-sm transition-all ${
                                                            isResolvingRewash[String(rw.id)] || submitQty <= 0
                                                                ? "bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed"
                                                                : "bg-white dark:bg-slate-800 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 hover:bg-purple-600 hover:text-white dark:hover:bg-purple-700"
                                                        }`}
                                                    >
                                                        {isResolvingRewash[String(rw.id)] ? "..." : `คืน ${submitQty || ""}`.trim()}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 transition-colors">
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!isComplete || isSubmitting}
                        className={`w-full py-3.5 rounded-xl font-bold text-white transition-all shadow-sm flex justify-center items-center gap-2
                            ${isComplete && !isSubmitting 
                                ? 'bg-[#1B4038] hover:bg-[#122b26]' 
                                : 'bg-slate-300 dark:bg-slate-800 text-slate-500 dark:text-slate-600 cursor-not-allowed shadow-none'}`}
                    >
                        {isSubmitting ? (
                           <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                           <>ถัดไป: ร้านซักเซ็นรับ <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>
                        )}
                    </button>
                    {!isComplete && (
                        <p className="text-center text-[10px] text-rose-500 dark:text-rose-400 font-bold mt-3 uppercase tracking-tighter">
                            * กรุณากรอกช่องรับจริงให้ครบทุกรายการ ยกเว้นถ้าไม่ได้รับคืนเลยให้ใส่ 0
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
