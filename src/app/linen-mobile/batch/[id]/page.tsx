"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useLinenBatchDetail } from "@/hooks/use-linen-batch";
import { MobileBatchStepDirty } from "@/components/linen/mobile-batch-step-dirty";
import { MobileBatchStepReturn } from "@/components/linen/mobile-batch-step-return";
import { MobileBatchStepVendorSign } from "@/components/linen/mobile-batch-step-vendor-sign";
import { MobileBatchStepFoSign } from "@/components/linen/mobile-batch-step-fo-sign";
import { BatchQrShare } from "@/components/linen/batch-qr-share";
import {
    formatLinenSummaryLines,
    formatPendingSummaryLines,
    formatReturnSummarySections,
    formatReturnSummaryRowsForDisplay,
    type ReturnSummaryDisplayRow,
    toAdjustedPendingSummaryRows,
    toResolvedRewashSummaryRows,
    toReturnSummaryRows,
    toRewashSummaryRows,
} from "@/lib/linen/rewash-summary";

type ReturnSummaryItem = ReturnSummaryDisplayRow;

export default function MobileBatchWizardPage() {
    const params = useParams();
    const searchParams = useSearchParams();
    const router = useRouter();
    const batchId = params.id === "new" ? null : (params.id as string);
    const draftKey = searchParams.get("draft");

    const { data: batchDetail, isLoading, mutate } = useLinenBatchDetail(batchId);
    const [currentStep, setCurrentStep] = useState<number | null>(null);
    const [draftData, setDraftData] = useState<any>(null);
    const [activeDraftKey, setActiveDraftKey] = useState<string | null>(null);
    const [finalToken, setFinalToken] = useState<string | null>(null);
    const [returnSummary, setReturnSummary] = useState<ReturnSummaryItem[]>([]);
    const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
    const [isReopening, setIsReopening] = useState(false);
    const [isDeletingBatch, setIsDeletingBatch] = useState(false);

    useEffect(() => {
        if (params.id === "new") {
            setCurrentStep(1);
            setDraftData(null);
            setActiveDraftKey(null);
            if (draftKey) {
                const saved = localStorage.getItem(draftKey);
                if (saved) {
                    setDraftData(JSON.parse(saved));
                    setActiveDraftKey(draftKey);
                }
            }
        } else if (batchDetail?.batch) {
            const status = batchDetail.batch.status;
            if (status === "fo_dirty_counted") setCurrentStep(2);
            else if (status === "fo_return_counted") setCurrentStep(3);
            else if (status === "vendor_signed") setCurrentStep(4);
            else if (["fo_return_signed", "closed", "partial", "disputed"].includes(status)) {
                setCurrentStep(5);
                // If it's already done, try to find a token if available
                if (batchDetail.tokens && batchDetail.tokens.length > 0) {
                    setFinalToken(batchDetail.tokens[0].token);
                }
            }
        }
    }, [params.id, batchDetail, draftKey]);

    const handleNext = (newBatchId?: string) => {
        if (newBatchId) {
            router.replace(`/linen-mobile/batch/${newBatchId}`);
        } else {
            mutate();
        }
    };

    const handleDeleteDraft = () => {
        if (!activeDraftKey) return;
        if (!confirm("ลบรายการร่างนี้หรือไม่?")) return;
        localStorage.removeItem(activeDraftKey);
        setDraftData(null);
        setActiveDraftKey(null);
        router.replace("/linen-mobile");
    };

    const batchStatus = String(batchDetail?.batch?.status ?? "");
    const canDeleteBatch = Boolean(batchId && ["fo_dirty_counted", "fo_return_counted", "vendor_signed"].includes(batchStatus));

    const handleDeleteBatch = async () => {
        if (!batchId || !canDeleteBatch) return;
        if (!confirm("ลบ Batch นี้หรือไม่? ข้อมูลรอบนี้จะถูกลบออกและย้อนยอดรับคืนที่บันทึกไว้แล้ว")) return;
        setIsDeletingBatch(true);
        try {
            const res = await fetch(`/api/linen/batches/${batchId}`, { method: "DELETE" });
            const result = await res.json().catch(() => null);
            if (!res.ok || result?.success === false) {
                throw new Error(result?.error || "Failed to delete batch");
            }
            router.replace("/linen-mobile");
        } catch (error) {
            console.error(error);
            const message = error instanceof Error ? error.message : "Unknown error";
            alert(`ลบ Batch ไม่สำเร็จ: ${message}`);
        } finally {
            setIsDeletingBatch(false);
        }
    };

    const handleReturnNext = async (summary: ReturnSummaryItem[] = [], qtys: Record<string, string> = {}) => {
        setReturnSummary(summary);
        setReturnQtyDraft(qtys);
        await mutate();
        setCurrentStep(3);
    };

    const reopenForEdit = async (targetStep: 1 | 2) => {
        if (!batchId || !batchDetail?.batch) return;
        const status = String(batchDetail.batch.status ?? "");
        if (["fo_return_signed", "closed", "partial"].includes(status)) {
            alert("รอบนี้จบงานแล้ว ถ้าต้องแก้ไขย้อนหลังให้ Admin Reopen ครับ");
            return;
        }
        setIsReopening(true);
        try {
            if (status !== "fo_dirty_counted") {
                const res = await fetch(`/api/linen/batches/${batchId}/reopen`, { method: "POST" });
                const result = await res.json().catch(() => null);
                if (!res.ok) throw new Error(result?.error || "Failed to reopen batch");
                setFinalToken(null);
            }
            await mutate();
            setCurrentStep(targetStep);
        } catch (error) {
            console.error(error);
            const message = error instanceof Error ? error.message : "Unknown error";
            alert(`ย้อนกลับเพื่อแก้ไขไม่สำเร็จ: ${message}`);
        } finally {
            setIsReopening(false);
        }
    };

    const handleHeaderBack = () => {
        if (!currentStep || currentStep <= 1) {
            router.push("/linen-mobile");
            return;
        }
        if (currentStep === 2) {
            setCurrentStep(1);
            return;
        }
        reopenForEdit(2);
    };

    const summaryText = useMemo(() => {
        if (!batchDetail?.items) return "";
        const items = batchDetail.items;
        const dirty = items.filter(i => !i.is_dayuse && i.sent_by_hotel > 0);
        const dayuse = items.filter(i => i.is_dayuse && i.sent_by_hotel > 0);
        const rewash = toRewashSummaryRows(batchDetail.rewash_events ?? []);
        const rewashReturns = toResolvedRewashSummaryRows(batchDetail.resolved_rewash_events ?? []);
        const eventReturns = toReturnSummaryRows(batchDetail.events ?? [], [
            ...items,
            ...(batchDetail.return_sources ?? []),
        ]);
        const pending = toAdjustedPendingSummaryRows(batchDetail.pending_items ?? [], batchDetail.events ?? [], [
            ...items,
            ...(batchDetail.return_sources ?? []),
        ]);
        const returns = eventReturns.length > 0
            ? eventReturns
            : returnSummary.length > 0
                ? returnSummary
                : items.filter(i => i.received_back > 0).map(i => ({ name: i.name_th ?? `Item ${i.linen_item_id}`, qty: i.received_back }));

        let text = `สรุปรายการผ้า [รอบ ${batchDetail.batch.pickup_round}]\nวันที่: ${batchDetail.batch.business_date}\n`;
        
        if (dirty.length > 0) {
            text += `\n--- ผ้าวันนี้ ---\n` + dirty.map(i => `${i.name_th}: ${i.sent_by_hotel} ชิ้น`).join("\n");
        }
        if (dayuse.length > 0) {
            text += `\n\n--- ผ้าเก่า ---\n` + dayuse.map(i => `${i.name_th}: ${i.sent_by_hotel} ชิ้น`).join("\n");
        }
        if (rewash.length > 0) {
            text += `\n\n--- ผ้าซักใหม่ ---\n` + formatLinenSummaryLines(rewash);
        }
        if (returns.length > 0) {
            text += `\n\n` + formatReturnSummarySections(returns);
        }
        if (rewashReturns.length > 0) {
            text += `\n\n--- รับคืนผ้าซักใหม่ ---\n` + formatLinenSummaryLines(rewashReturns);
        }
        if (pending.length > 0) {
            text += `\n\n--- ผ้าค้าง ---\n` + formatPendingSummaryLines(pending);
        }
        
        return text;
    }, [batchDetail, returnSummary]);

    const eventReturnSummary = useMemo(() => {
        return toReturnSummaryRows(batchDetail?.events ?? [], [
            ...(batchDetail?.items ?? []),
            ...(batchDetail?.return_sources ?? []),
        ]);
    }, [batchDetail]);

    const activeReturnSummary = eventReturnSummary.length > 0
        ? formatReturnSummaryRowsForDisplay(eventReturnSummary)
        : returnSummary;

    if (isLoading && params.id !== "new") {
        return <div className="p-10 text-center text-slate-400 font-thai">กำลังโหลดข้อมูลรอบ...</div>;
    }

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col p-4">
            <header className="flex items-center justify-between mb-4">
                <button 
                    onClick={handleHeaderBack}
                    disabled={isReopening}
                    className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-slate-400 shadow-sm border border-slate-100 active:scale-90 transition-all"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5"><path d="M15 18l-6-6 6-6"/></svg>
                </button>
                <div className="flex-1 text-center">
                    <span className="text-sm font-bold text-slate-300 uppercase tracking-widest">
                        {currentStep && currentStep < 5 ? `Step ${currentStep} / 4` : "Completed"}
                    </span>
                </div>
                {canDeleteBatch ? (
                    <button
                        type="button"
                        onClick={handleDeleteBatch}
                        disabled={isDeletingBatch || isReopening}
                        className="rounded-full border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isDeletingBatch ? "..." : "ลบ Batch"}
                    </button>
                ) : (
                    <div className="w-10" />
                )}
            </header>

            <div className="flex-1">
                {currentStep === 1 && (
                    <MobileBatchStepDirty
            key={activeDraftKey ?? batchId ?? "new"}
                        initialData={draftData}
                        draftKey={activeDraftKey}
                        batchId={batchId}
                        batchDetail={batchDetail}
                        onDeleteDraft={handleDeleteDraft}
                        onNext={handleNext}
                    />
                )}
                {currentStep === 2 && batchDetail && (
                    <MobileBatchStepReturn 
                        batchId={batchId!} 
                        items={batchDetail.items} 
                        returnSources={batchDetail.return_sources || []} 
                        initialReturnQtys={returnQtyDraft}
                        onBack={() => setCurrentStep(1)}
                        onNext={handleReturnNext} 
                    />
                )}
                {currentStep === 3 && batchDetail && (
                    <MobileBatchStepVendorSign 
                        batchId={batchId!} 
                        items={batchDetail.items} 
                        rewashEvents={batchDetail.rewash_events ?? []}
                        returnSummary={activeReturnSummary}
                        rewashReturnSummary={toResolvedRewashSummaryRows(batchDetail.resolved_rewash_events ?? [])}
                        onNext={() => handleNext()}
                        onBack={() => reopenForEdit(2)}
                    />
                )}
                {currentStep === 4 && batchDetail && (
                    <MobileBatchStepFoSign 
                        batchId={batchId!} 
                        items={batchDetail.items} 
                        rewashEvents={batchDetail.rewash_events ?? []}
                        returnSummary={activeReturnSummary}
                        rewashReturnSummary={toResolvedRewashSummaryRows(batchDetail.resolved_rewash_events ?? [])}
                        onDone={(token) => {
                            setFinalToken(token);
                            setCurrentStep(5);
                        }}
                        onBack={() => reopenForEdit(2)}
                    />
                )}
                {currentStep === 5 && (
                    <div className="animate-in fade-in duration-500">
                        <BatchQrShare token={finalToken || ""} summaryText={summaryText} />
                        <div className="mt-8">
                             <button
                                onClick={() => router.push("/linen-mobile")}
                                className="w-full py-4 bg-slate-100 text-slate-500 font-bold rounded-2xl border border-slate-200 active:bg-slate-200 transition-colors"
                             >
                                กลับหน้าหลัก
                             </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
