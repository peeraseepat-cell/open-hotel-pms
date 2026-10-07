"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Camera, CheckCircle2, Loader2, Upload, User, Users, AlertTriangle } from "lucide-react";
import { buildPassportMrzBlob, PASSPORT_OCR_MAX_FILE_BYTES } from "@/lib/passport-ocr/client-preprocess";

type FillTarget = "main" | "accompanying";
type Step = "select" | "upload" | "processing" | "complete";

interface OcrResult {
  firstName?: string | null;
  familyName?: string | null;
  passportNumber?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
}

export default function FillOcrPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const resId = params.resId as string;
  const isInHouse = searchParams.get("inhouse") === "1";

  const [step, setStep] = useState<Step>(isInHouse ? "upload" : "select");
  const [target, setTarget] = useState<FillTarget>(isInHouse ? "accompanying" : "main");
  const [guestIndex, setGuestIndex] = useState(0); // 0=main, 1+=accompanying
  const [roomInfo, setRoomInfo] = useState<{ room_number: string; guest_name: string } | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [bookingNameNote, setBookingNameNote] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [accomCount, setAccomCount] = useState(0);
  const [accomIndexes, setAccomIndexes] = useState<number[]>([]);
  const [partyLoaded, setPartyLoaded] = useState(false);
  const [partyError, setPartyError] = useState("");
  const [partyReload, setPartyReload] = useState(0);
  const nextAccompanyingIndex = (indexes: number[]) => [1, 2, 3].find(index => !indexes.includes(index)) ?? 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load room info
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/checkin/due-today?include_inhouse=1");
        const json = await res.json().catch(() => null);
        if (!json?.success) return;
        const allRooms = [...(json.data.rooms ?? []), ...(json.data.inhouse ?? [])];
        const room = allRooms.find((r: any) => r.reservation_id === resId);
        if (room) {
          setRoomInfo({ room_number: room.room_number, guest_name: room.guest_name });
        }
      } catch { /* ignore */ }
    })();

    const controller = new AbortController();
    setPartyLoaded(false); setPartyError(""); setAccomIndexes([]); setAccomCount(0); setGuestIndex(0);
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${resId}/guests`, { signal: controller.signal });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success || !Array.isArray(json.guests)) throw new Error(json?.error || "Could not load accompanying guests.");
        if (controller.signal.aborted) return;
        const accompanying = json.guests.filter((guest: any) => guest.role === "accompanying");
        const indexes = accompanying.map((guest: any) => Number(guest.display_order) - 1);
        if (indexes.some((index: number) => !Number.isInteger(index) || index < 1 || index > 3) || new Set(indexes).size !== indexes.length) throw new Error("Existing guest slots are invalid. Check the booking before scanning.");
        setAccomIndexes(indexes); setAccomCount(accompanying.length); setPartyLoaded(true);
        if (isInHouse) setGuestIndex(nextAccompanyingIndex(indexes));
      } catch (loadError) {
        if (!controller.signal.aborted) setPartyError(loadError instanceof Error ? loadError.message : "Could not load accompanying guests.");
      }
    })();
    return () => controller.abort();
  }, [resId, isInHouse, partyReload]);

  const selectTarget = (t: FillTarget) => {
    setTarget(t);
    setGuestIndex(t === "main" ? 0 : nextAccompanyingIndex(accomIndexes));
    setStep("upload");
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (target === "accompanying" && (!partyLoaded || !guestIndex)) { setError(partyError || "Load the guest list before scanning."); return; }

    if (!file.type.startsWith("image/")) {
      setError("กรุณาอัพโหลดไฟล์รูปภาพ");
      return;
    }
    if (file.size > PASSPORT_OCR_MAX_FILE_BYTES) {
      setError("ไฟล์ใหญ่เกิน 10MB");
      return;
    }

    setStep("processing");
    setError("");
    setOcrResult(null);

    try {
      const mrzBlob = await buildPassportMrzBlob(file);
      const formData = new FormData();
      formData.append("image", mrzBlob, "passport-mrz.jpg");
      formData.append("reservation_id", resId);
      formData.append("target", target);
      formData.append("guest_index", String(guestIndex));

      const res = await fetch("/api/checkin/fill-ocr", {
        method: "POST",
        body: formData,
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Fill OCR failed.");
      }

      setOcrResult(json.data.parsed);
      setBookingNameNote(json.data.booking_name_note || null);

      if (target === "accompanying") {
        setAccomCount((prev) => prev + 1);
        setAccomIndexes(prev => [...prev, Number(json.data.guest_index)]);
      }

      setStep("complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : "OCR failed.";
      setError(message);
      setStep("upload");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addAnotherAccom = () => {
    setTarget("accompanying");
    setGuestIndex(nextAccompanyingIndex(accomIndexes));
    setOcrResult(null);
    setBookingNameNote(null);
    setError("");
    setStep("upload");
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-muted)]">
      {partyError && <div role="alert" className="p-4 text-red-700">{partyError} <button type="button" onClick={() => setPartyReload(value => value + 1)}>Retry guest list</button></div>}
      <header className="px-6 py-4 border-b border-[var(--border-default)] bg-[var(--bg-surface)] sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <Link
            href="/pms/mobile-checkin/fill-ocr"
            className="p-3 -ml-3 rounded-full hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] transition"
          >
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Fill OCR</h1>
            {roomInfo && (
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                Room {roomInfo.room_number} &middot; {roomInfo.guest_name}
              </p>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 flex flex-col">
        {error && (
          <div className="mb-6 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-xl flex items-start gap-3 text-sm font-medium">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Step: Select Main or Accompanying */}
        {step === "select" && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-6">
            <h2 className="text-lg font-black text-[var(--text-primary)] uppercase tracking-wide">
              Fill for whom?
            </h2>

            <button
              onClick={() => selectTarget("main")}
              className="w-full max-w-sm bg-[var(--bg-surface)] border-2 border-brand-500/30 rounded-2xl p-6 flex items-center gap-4 hover:bg-brand-50 dark:hover:bg-brand-500/10 active:scale-[0.98] transition"
            >
              <div className="w-14 h-14 bg-brand-100 dark:bg-brand-500/20 rounded-full flex items-center justify-center text-brand-600 dark:text-brand-400">
                <User className="w-7 h-7" />
              </div>
              <div className="text-left">
                <p className="text-lg font-black text-[var(--text-primary)]">Main Guest</p>
                <p className="text-xs font-semibold text-[var(--text-muted)] mt-0.5">
                  OCR จะ fill ข้อมูลแขกหลัก
                </p>
              </div>
            </button>

            <button
              onClick={() => selectTarget("accompanying")}
              disabled={!partyLoaded || accomCount >= 3}
              className="w-full max-w-sm bg-[var(--bg-surface)] border-2 border-indigo-500/30 rounded-2xl p-6 flex items-center gap-4 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="w-14 h-14 bg-indigo-100 dark:bg-indigo-500/20 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                <Users className="w-7 h-7" />
              </div>
              <div className="text-left">
                <p className="text-lg font-black text-[var(--text-primary)]">Accompanying Guest</p>
                <p className="text-xs font-semibold text-[var(--text-muted)] mt-0.5">
                  {accomCount >= 3
                    ? "เต็มแล้ว (3/3)"
                    : `เพิ่มผู้ร่วมเดินทาง (${accomCount}/3)`}
                </p>
              </div>
            </button>
          </div>
        )}

        {/* Step: Upload Photo */}
        {step === "upload" && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-6">
            <div className="text-center space-y-2">
              <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${
                target === "main"
                  ? "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-400"
                  : "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-400"
              }`}>
                {target === "main" ? <User className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                {target === "main" ? "Main Guest" : `Accompanying #${guestIndex}`}
              </div>
              <h2 className="text-2xl font-black text-[var(--text-primary)]">Upload Passport</h2>
              <p className="text-sm font-medium text-[var(--text-secondary)] max-w-[280px] mx-auto">
                อัพโหลดรูป Passport ระบบจะอ่าน MRZ แล้ว Fill ข้อมูลอัตโนมัติ
              </p>
              <p className="text-xs font-bold text-amber-600 dark:text-amber-400">
                * ไม่บันทึกรูป — เก็บแค่ข้อมูลตัวอักษร
              </p>
            </div>

            <button
              disabled={target === "accompanying" && (!partyLoaded || guestIndex === 0)}
              onClick={() => fileInputRef.current?.click()}
              className="w-36 h-36 bg-brand-600 rounded-full flex items-center justify-center text-white shadow-xl shadow-brand-500/30 hover:bg-brand-700 active:scale-95 transition-all outline outline-[12px] outline-brand-500/10"
            >
              <Upload className="w-14 h-14" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
            <p className="text-xs text-[var(--text-muted)]">
              รองรับ jpg, png, webp (สูงสุด 10MB)
            </p>
          </div>
        )}

        {/* Step: Processing */}
        {step === "processing" && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-6">
            <Loader2 className="w-16 h-16 text-brand-500 animate-spin" />
            <p className="text-lg font-bold text-[var(--text-primary)]">Scanning MRZ...</p>
            <p className="text-sm text-[var(--text-secondary)]">
              กำลังอ่าน Passport แล้ว Fill ข้อมูล
            </p>
          </div>
        )}

        {/* Step: Complete */}
        {step === "complete" && ocrResult && (
          <div className="flex-1 flex flex-col space-y-6">
            <div className="border-2 border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl p-6 text-center">
              <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-3" />
              <h2 className="text-xl font-black text-emerald-700 dark:text-emerald-400 uppercase">
                Fill Complete!
              </h2>
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-300 mt-1">
                {target === "main" ? "Main Guest" : "Accompanying Guest"} updated
              </p>
            </div>

            {bookingNameNote && (
              <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-300 rounded-xl p-3 text-sm font-semibold text-amber-700 dark:text-amber-400">
                📋 {bookingNameNote}
              </div>
            )}

            {/* OCR Results */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
              <div className="bg-[var(--bg-surface-hover)] px-5 py-3 border-b border-[var(--border-default)]">
                <h3 className="text-sm font-bold text-[var(--text-secondary)] uppercase">
                  Filled Data
                </h3>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { label: "Name", value: `${ocrResult.firstName ?? ""} ${ocrResult.familyName ?? ""}`.trim() },
                  { label: "Passport", value: ocrResult.passportNumber },
                  { label: "Nationality", value: ocrResult.nationality },
                  { label: "DOB", value: ocrResult.dateOfBirth },
                  { label: "Gender", value: ocrResult.gender },
                ].map((row) => (
                  <div key={row.label} className="flex justify-between items-center">
                    <span className="text-xs font-bold text-[var(--text-muted)] uppercase">{row.label}</span>
                    <span className={`text-sm font-bold ${row.value ? "text-[var(--text-primary)]" : "text-rose-500"}`}>
                      {row.value || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-3 mt-auto pb-6">
              {accomCount < 3 && (
                <button
                  onClick={addAnotherAccom}
                  className="w-full h-14 bg-indigo-600 text-white rounded-2xl font-bold uppercase tracking-wide shadow-lg shadow-indigo-500/20 active:scale-[0.98] transition flex items-center justify-center gap-2"
                >
                  <Users className="w-5 h-5" /> Add Accompanying Guest ({accomCount}/3)
                </button>
              )}

              <Link
                href="/pms/mobile-checkin/fill-ocr"
                className="w-full h-14 bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] rounded-2xl font-bold uppercase tracking-wide active:scale-[0.98] transition flex items-center justify-center gap-2"
              >
                <ArrowLeft className="w-5 h-5" /> Back to Room List
              </Link>

              <Link
                href="/pms/mobile-checkin"
                className="w-full h-12 text-[var(--text-secondary)] font-semibold text-sm text-center flex items-center justify-center"
              >
                Home
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
