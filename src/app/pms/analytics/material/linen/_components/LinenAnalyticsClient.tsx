"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FilterBar } from "../../../_components/FilterBar";
import { TrendChart } from "../../../_components/TrendChart";
import { LinenKpiRow } from "./LinenKpiRow";
import { LinenVarianceTable } from "./LinenVarianceTable";
import type { AnalyticsMetric, AnalyticsTrendPoint, AnalyticsWindow } from "@/lib/analytics/types";

const LINEN_CATEGORY_OPTIONS = [
    { value: "linen.pillowcase", label: "Pillowcase" },
    { value: "linen.bath_towel", label: "Towel" },
    { value: "linen.bath_mat", label: "Bath Mat" },
    { value: "linen.single_bed_sheet", label: "Single Bed Sheet" },
    { value: "linen.double_bed_sheet", label: "Double Bed Sheet" },
    { value: "linen.king_bed_sheet", label: "King Bed Sheet" },
    { value: "linen.single_duvet_cover", label: "Single Duvet Cover" },
    { value: "linen.double_duvet_cover", label: "Double Duvet Cover" },
    { value: "linen.king_duvet_cover", label: "King Duvet Cover" },
];

function defaultStart() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function defaultEnd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    const text = await response.text();
    let body: { success?: boolean; data?: T; error?: string } | null = null;

    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }

    if (!response.ok || !body?.success) {
        const lower = text.toLowerCase();
        if (response.status === 502 || lower.includes("bad gateway")) {
            throw new Error("Supabase gateway returned 502 while loading Linen Analytics. The app now throttles the heavy expected-linen calculation; please retry in a moment.");
        }
        throw new Error(body?.error ?? `Request failed (${response.status})`);
    }
    return body.data as T;
}

export default function LinenAnalyticsClient() {
    const params = useSearchParams();
    const [metric, setMetric] = useState<AnalyticsMetric | null>(null);
    const [trend, setTrend] = useState<AnalyticsTrendPoint[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const window = (params.get("window") as AnalyticsWindow) || "month";
    const start = params.get("start") || defaultStart();
    const end = params.get("end") || defaultEnd();
    const category = params.get("category") || "";
    const roomType = params.get("room_type") || "";

    const queryString = useMemo(() => {
        const qs = new URLSearchParams({ window, start, end });
        if (category) qs.set("category", category);
        if (roomType) qs.set("room_type", roomType);
        return qs.toString();
    }, [category, end, roomType, start, window]);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);

        async function load() {
            const nextMetric = await fetchJson<AnalyticsMetric>(`/api/analytics/material/linen?${queryString}`);
            const nextTrend = await fetchJson<AnalyticsTrendPoint[]>(`/api/analytics/material/linen/trend?${queryString}`);
            return [nextMetric, nextTrend] as const;
        }

        load()
            .then(([nextMetric, nextTrend]) => {
                if (cancelled) return;
                setMetric(nextMetric);
                setTrend(nextTrend);
            })
            .catch((err) => {
                if (cancelled) return;
                setMetric(null);
                setTrend([]);
                setError(err instanceof Error ? err.message : "Failed to load linen analytics");
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [queryString]);

    const needsMigrationHint = error
        ? /function|rpc|schema cache|does not exist/i.test(error)
        : false;

    return (
        <div className="max-w-[1400px] mx-auto p-6 space-y-5 pb-24">
            <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                <div>
                    <div className="a-muted text-[11px] uppercase tracking-[0.2em]">Phase 68.1 · live</div>
                    <h1 className="text-2xl font-semibold tracking-tight mt-1">Linen Analytics</h1>
                    <p className="a-secondary text-sm mt-1">
                        Actual sent linen against expected pickup and room setup capacity.
                    </p>
                </div>
                <Link href="/pms/analytics/material" className="a-card px-3 py-2 text-xs a-secondary hover:text-[var(--a-text-0)]">
                    Back to Material
                </Link>
            </header>

            <FilterBar
                categoryOptions={LINEN_CATEGORY_OPTIONS}
                showCategory
                showRoomType
            />

            <div className="a-card p-3 border-l-2 border-[var(--a-accent-cyan)]">
                <p className="a-secondary text-xs">
                    Max uses sold room nights from the previous stay date. When Room Type is filtered, Actual becomes an allocated estimate because laundry batches store item totals, not room-type splits.
                </p>
            </div>

            {error && (
                <div className="a-card p-4 border-l-2 border-[var(--a-accent-rose)] text-sm">
                    <div className="font-semibold">Unable to load Linen Analytics</div>
                    <p className="a-secondary mt-1">{error}</p>
                    {needsMigrationHint && (
                        <p className="a-muted text-[11px] mt-2">
                            If this says the RPC function does not exist, apply migration 20260418000199_phase68_1_linen_analytics.sql.
                        </p>
                    )}
                </div>
            )}

            {isLoading ? (
                <LoadingState />
            ) : (
                <>
                    <LinenKpiRow metric={metric} />
                    <TrendChart data={trend} />
                    <LinenVarianceTable buckets={metric?.buckets ?? []} />
                </>
            )}
        </div>
    );
}

function LoadingState() {
    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, idx) => (
                    <div key={idx} className="a-card h-28 animate-pulse bg-[var(--a-bg-2)]/40" />
                ))}
            </div>
            <div className="a-card h-72 animate-pulse bg-[var(--a-bg-2)]/40" />
            <div className="a-card h-80 animate-pulse bg-[var(--a-bg-2)]/40" />
        </div>
    );
}
