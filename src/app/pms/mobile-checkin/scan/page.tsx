"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, CheckCircle2, AlertTriangle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { buildPassportMrzBlob, PASSPORT_OCR_MAX_FILE_BYTES } from "@/lib/passport-ocr/client-preprocess";

type Step = "capture" | "processing" | "result";

export default function ScanPassport() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState<Step>("capture");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  // OCR & Match State
  const [scanResult, setScanResult] = useState<any>(null);
  const [matchResult, setMatchResult] = useState<any>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please upload a valid image file.");
      return;
    }
    
    if (file.size > PASSPORT_OCR_MAX_FILE_BYTES) {
      alert("File size exceeds 10MB limit. Please capture a smaller photo.");
      return;
    }

    // Show preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setStep("processing");

    // Process APIs
    try {
      // 1. Scan Passport
      const mrzBlob = await buildPassportMrzBlob(file);
      const formData = new FormData();
      formData.append("image", mrzBlob, "passport-mrz.jpg");
      formData.append("source", "tight_mrz");
      const res1 = await fetch("/api/checkin/scan-passport", { method: "POST", body: formData });
      const json1 = await res1.json().catch(() => null);
      if (!res1.ok || !json1?.success) {
        throw new Error(json1?.error || "Passport scan failed.");
      }
      const scanData = json1.data;
      setScanResult(scanData);

      if (scanData.mrz_failed || !scanData.parsed) {
        sessionStorage.removeItem("mobile-checkin-temp-ocr");
        // MRZ unreadable — the photo is already saved to the pool. Skip auto-match and
        // force manual room selection (the guest name is confirmed later at that step).
        setMatchResult(null);
        setStep("result");
        return;
      }

      // 2. Match Booking
      const ocrName = `${scanData.parsed.firstName} ${scanData.parsed.familyName}`;
      const res2 = await fetch("/api/checkin/match-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ocr_name: ocrName,
          scan_id: scanData.scan_id,
        })
      });
      const json2 = await res2.json().catch(() => null);
      if (!res2.ok || !json2?.success) {
        throw new Error(json2?.error || "Booking match failed.");
      }
      const matchData = json2.data;
      setMatchResult(matchData);
      
      // Store OCR data temporarily so guest-info can grab it 
      // instead of hitting the database again while Agent B finishes APIs.
      if (typeof window !== "undefined") {
        sessionStorage.setItem("mobile-checkin-temp-ocr", JSON.stringify({
          scan_id: scanData.scan_id,
          parsed: scanData.parsed
        }));
      }

      setStep("result");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Processing failed. Please try again.";
      alert(message);
      setStep("capture");
    }
  };

  const isMatched = matchResult?.auto_matched && matchResult?.best_match?.confidence >= 80;
  const bestMatchObj = matchResult?.matches?.find((m: any) => m.reservation_id === matchResult?.best_match?.reservation_id);

  const proceedToCheckin = () => {
    if (isMatched && bestMatchObj) {
      router.push(`/pms/mobile-checkin/guest-info/${bestMatchObj.reservation_id}?scan_id=${scanResult.scan_id}`);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-body)]">
      <header className="px-6 py-4 flex items-center gap-4 bg-[var(--bg-surface)]">
        <Link 
          href="/pms/mobile-checkin/method"
          className="p-3 -ml-3 rounded-full hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] transition"
        >
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Scan Passport</h1>
      </header>

      <main className="flex-1 p-6 flex flex-col">
        {step === "capture" && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-6">
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-black text-[var(--text-primary)]">Capture Photo</h2>
              <p className="text-[var(--text-secondary)] font-medium max-w-[280px] mx-auto">
                Align the passport data page clearly in the camera frame.
              </p>
            </div>
            
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-32 h-32 bg-brand-600 rounded-full flex items-center justify-center text-white shadow-xl shadow-brand-500/30 hover:bg-brand-700 active:scale-95 transition-all outline outline-[12px] outline-brand-500/10"
            >
              <Camera className="w-12 h-12" />
            </button>
            <input 
              ref={fileInputRef}
              type="file" 
              accept="image/*" 
              capture="environment" 
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        )}

        {step === "processing" && (
          <div className="flex-1 flex flex-col justify-center space-y-6">
            <div className="mx-auto relative w-48 h-64 rounded-xl overflow-hidden shadow-lg border-2 border-brand-500">
              {previewUrl && (
                <img src={previewUrl} alt="Passport preview" className="w-full h-full object-cover filter blur-[2px] opacity-70" />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-brand-900/40">
                <Loader2 className="w-10 h-10 text-white animate-spin" />
                <p className="text-white font-bold text-sm bg-black/50 px-3 py-1 rounded-full backdrop-blur-sm">
                  Scanning MRZ...
                </p>
              </div>
            </div>
          </div>
        )}

        {step === "result" && (
          <div className="flex-1 flex flex-col space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            {isMatched ? (
              <div className="border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl p-6 shadow-sm overflow-hidden relative">
                <div className="absolute -right-4 -top-4 opacity-[0.05] pointer-events-none">
                  <CheckCircle2 className="w-32 h-32" />
                </div>
                
                <h2 className="text-xl font-black text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                   <CheckCircle2 className="w-6 h-6" /> MATCH FOUND: {bestMatchObj?.confidence}%
                </h2>
                
                <div className="mt-6 space-y-1">
                  <p className="text-sm font-bold text-emerald-600/70 uppercase tracking-widest">Guest Info</p>
                  <p className="text-2xl font-black text-[var(--text-primary)]">
                    Room {bestMatchObj?.room_number} <span className="text-emerald-600">· {bestMatchObj?.guest_name}</span>
                  </p>
                </div>
                
                <button
                  onClick={proceedToCheckin}
                  className="mt-8 w-full h-14 bg-emerald-600 text-white rounded-xl font-bold tracking-wide uppercase shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  Proceed Check-in
                </button>

                <div className="mt-4 text-center">
                  <Link 
                    href={`/pms/mobile-checkin/select-room?scan_id=${scanResult?.scan_id}`}
                    className="text-sm font-semibold text-[var(--text-secondary)] hover:text-emerald-600 underline underline-offset-4"
                  >
                    Wrong match? Select manually
                  </Link>
                </div>
              </div>
            ) : (
              <div className="border border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 rounded-2xl p-6 shadow-sm">
                <h2 className="text-xl font-black text-amber-700 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="w-6 h-6" /> CANNOT AUTO-MATCH
                </h2>
                
                <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                  {scanResult?.mrz_failed
                    ? "เก็บรูปพาสปอร์ตแล้ว (30 วัน) แต่อ่าน MRZ ไม่ออก — เลือกห้องแล้วกรอกข้อมูลแขกเอง"
                    : "Passport photo saved (30 days). Name similarity below 80%."}
                </p>

                <div className="mt-6 bg-amber-100 dark:bg-amber-900/50 p-4 rounded-xl border border-amber-200 dark:border-amber-500/20">
                  <p className="text-amber-800 dark:text-amber-300 font-bold text-sm mb-1 uppercase tracking-wider">
                    Manual Match Required
                  </p>
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-400 line-clamp-3">
                    หา booking อัตโนมัติไม่เจอจากชื่อใน passport
                    แต่ยังเลือกห้องเองแล้ว check-in ต่อได้ตามปกติ
                    โดยจะยึดชื่อแขกจริงตอน confirm
                  </p>
                </div>

                <Link
                  href={`/pms/mobile-checkin/select-room?scan_id=${scanResult?.scan_id}`}
                  className="mt-8 w-full h-14 bg-amber-500 text-white rounded-xl font-bold tracking-wide uppercase shadow-lg shadow-amber-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  Select Room Manually
                </Link>
                
                <button
                  onClick={() => setStep("capture")}
                  className="mt-4 w-full h-14 flex items-center justify-center gap-2 text-sm font-bold text-[var(--text-secondary)] hover:text-amber-600 transition"
                >
                   <RefreshCw className="w-4 h-4" /> Rescan Passport
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
