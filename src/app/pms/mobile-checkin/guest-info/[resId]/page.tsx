"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, Trash2, Camera, ShieldAlert, Loader2, AlertTriangle } from "lucide-react";
import { buildPassportMrzBlob, PASSPORT_OCR_MAX_FILE_BYTES } from "@/lib/passport-ocr/client-preprocess";

type ExistingProfileCandidate = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  passport_no?: string | null;
  id_number?: string | null;
  nationality_code?: string | null;
  phone?: string | null;
  profile_status?: string | null;
};

function companionSlot(guest: any, index: number): number {
  const slot = Number(guest?.passport_guest_index);
  return Number.isInteger(slot) && slot >= 1 && slot <= 3 ? slot : index + 1;
}

function normalizeCompanions(guests: any[]): any[] {
  return guests.map((guest, index) => ({ ...guest, passport_guest_index: companionSlot(guest, index) }));
}

function hasGuestData(guest: any, scanId?: string | null): boolean {
  return Boolean(scanId || guest?.passport_scan_id) ||
    ["full_name", "passport_no", "nationality", "date_of_birth", "gender"].some(key => String(guest?.[key] ?? "").trim());
}

function normalizePassportNo(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function composeProfileName(profile: ExistingProfileCandidate | null): string {
  if (!profile) return "";
  const first = String(profile.first_name ?? "").trim();
  const last = String(profile.last_name ?? "").trim();
  return `${first} ${last}`.trim();
}

export default function GuestInfo() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const resId = params.resId as string;
  const scanId = searchParams.get("scan_id");
  const isDraftFromUrl = searchParams.get("draft") === "true";

  // State
  const [mainGuest, setMainGuest] = useState({
    full_name: "",
    passport_no: "",
    nationality: "",
    date_of_birth: "",
    gender: ""
  });

  const [accompanying, setAccompanying] = useState<any[]>([]);
  const [loadingName, setLoadingName] = useState(true);
  const [bookingNameNote, setBookingNameNote] = useState<string | null>(null);
  const [mainScanId, setMainScanId] = useState<string | null>(scanId);
  const [mainScanning, setMainScanning] = useState(false);
  const [accScanning, setAccScanning] = useState<number | null>(null);
  const [accOcrWarnings, setAccOcrWarnings] = useState<Map<number, string[]>>(new Map());
  const [profileLookupLoading, setProfileLookupLoading] = useState(false);
  const [profileLookupError, setProfileLookupError] = useState<string | null>(null);
  const [profileCandidate, setProfileCandidate] = useState<ExistingProfileCandidate | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const lookupRequestRef = useRef(0);
  const mainCameraRef = useRef<HTMLInputElement>(null);
  const accCameraRef = useRef<HTMLInputElement>(null);
  const accScanSlotRef = useRef<number | null>(null);
  const [originalBookingName, setOriginalBookingName] = useState("");
  const [overwriteTarget, setOverwriteTarget] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<number | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // Hydrate OCR data & Load Session & Fetch Original Name
  useEffect(() => {
    let _originalName = "";

    const loadOriginalName = async () => {
      try {
        const res = await fetch("/api/checkin/due-today");
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
          throw new Error(json?.error || "Failed to load due-in list.");
        }
        const data = json.data.rooms;
        
        const room = data.find((r: any) => r.reservation_id === resId);
        if (room) {
          _originalName = room.guest_name;
          setOriginalBookingName(_originalName);
        }
      } catch (e) {
        console.error("Failed fetching original name", e);
      } finally {
        setLoadingName(false);
      }
    };

    const processHydration = async () => {
      await loadOriginalName();

      // 1. Check if we already have session data for this reservation
      const saved = sessionStorage.getItem(`mobile-checkin-${resId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        setMainScanId(scanId || (parsed.scan_id ? String(parsed.scan_id) : null));
        if (parsed.guest_info) {
          setMainGuest(parsed.guest_info);
        } else if (_originalName) {
          setMainGuest((prev) => ({ ...prev, full_name: _originalName }));
        }
        if (parsed.selected_profile_id) {
          setSelectedProfileId(String(parsed.selected_profile_id));
        }
        if (parsed.accompanying_guests) setAccompanying(normalizeCompanions(parsed.accompanying_guests));
        else if (parsed.accompanying) setAccompanying(normalizeCompanions(parsed.accompanying));
        return;
      }

      // 2. Otherwise try loading OCR data from temp storage (or fallback to original name)
      const tempOcrTxt = sessionStorage.getItem("mobile-checkin-temp-ocr");
      if (tempOcrTxt && scanId) {
        const tempOcr = JSON.parse(tempOcrTxt);
        if (tempOcr.scan_id === scanId) {
          setMainGuest(prev => ({
            ...prev,
            full_name: `${tempOcr.parsed.firstName} ${tempOcr.parsed.familyName}`,
            passport_no: tempOcr.parsed.passportNumber || "",
            nationality: tempOcr.parsed.nationality || "",
            date_of_birth: tempOcr.parsed.dateOfBirth || "",
            gender: tempOcr.parsed.gender || ""
          }));
        }
      } else {
        // No OCR, just normal manual fallback
        setMainGuest(prev => ({ ...prev, full_name: _originalName }));
      }
    };

    processHydration();
  }, [resId, scanId]);

  useEffect(() => {
    const passportNo = normalizePassportNo(mainGuest.passport_no);
    const requestId = ++lookupRequestRef.current;

    if (!passportNo || passportNo.length < 4) {
      setProfileCandidate(null);
      setProfileLookupError(null);
      setProfileLookupLoading(false);
      setSelectedProfileId((prev) => (prev ? null : prev));
      return;
    }

    setProfileLookupLoading(true);
    setProfileLookupError(null);
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          id_type: "passport",
          id_number: passportNo,
          checkin_mode: "true",
          reservation_id: resId,
        });
        const res = await fetch(`/api/guests/by-id?${qs.toString()}`);
        const json = await res.json().catch(() => null);
        if (requestId !== lookupRequestRef.current) return;
        if (!res.ok || !json?.success) {
          throw new Error(json?.error || "ค้นหาโปรไฟล์ไม่สำเร็จ");
        }

        const found = (json.profile ?? null) as ExistingProfileCandidate | null;
        setProfileCandidate(found);
        if (found) {
          setSelectedProfileId((prev) => (prev && found.id !== prev ? null : prev));
        }
      } catch (err) {
        if (requestId !== lookupRequestRef.current) return;
        setProfileCandidate(null);
        setSelectedProfileId(null);
        setProfileLookupError(err instanceof Error ? err.message : "ค้นหาโปรไฟล์ไม่สำเร็จ");
      } finally {
        if (requestId === lookupRequestRef.current) {
          setProfileLookupLoading(false);
        }
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [mainGuest.passport_no, resId]);

  const useExistingProfile = () => {
    if (!profileCandidate?.id) return;
    const profileName = composeProfileName(profileCandidate);
    const profilePassport = normalizePassportNo(profileCandidate.passport_no || profileCandidate.id_number || "");
    setSelectedProfileId(profileCandidate.id);
    setMainGuest((prev) => ({
      ...prev,
      full_name: profileName || prev.full_name,
      passport_no: profilePassport || prev.passport_no,
      nationality: String(profileCandidate.nationality_code ?? prev.nationality ?? "").toUpperCase(),
    }));
  };

  const addAccompanying = () => {
    if (accompanying.length >= 3) return;
    const current = normalizeCompanions(accompanying);
    const slot = [1, 2, 3].find(value => !current.some(guest => guest.passport_guest_index === value));
    if (slot === undefined) return;
    setAccompanying([...current, { full_name: "", passport_no: "", nationality: "", date_of_birth: "", gender: "", source: "manual", passport_guest_index: slot, passport_scan_id: null }]);
  };

  const removeAccompanying = (index: number) => {
    setRemoveTarget(index);
  };

  const updateAccompanying = (index: number, key: string, value: string) => {
    const newAcc = [...accompanying];
    newAcc[index][key] = value;
    setAccompanying(newAcc);
  };

  const onNext = () => {
    if (!mainGuest.full_name.trim()) return alert("Main Guest Name is required.");
    
    const sessionKey = `mobile-checkin-${resId}`;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(sessionStorage.getItem(sessionKey) || "{}"); } catch { /* Start a new session if stored JSON is corrupt. */ }
    sessionStorage.setItem(sessionKey, JSON.stringify({
      ...current,
      scan_id: mainScanId,
      selected_profile_id: selectedProfileId,
      guest_info: mainGuest,
      accompanying_guests: normalizeCompanions(accompanying),
      booking_name_note: bookingNameNote,
    }));
    
    router.push(`/pms/mobile-checkin/payment/${resId}`);
  };

  const handleMainGuestScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > PASSPORT_OCR_MAX_FILE_BYTES) {
      alert("Please upload a valid image under 10MB.");
      return;
    }
    setMainScanning(true);
    try {
      const mrzBlob = await buildPassportMrzBlob(file);
      const formData = new FormData();
      formData.append("image", mrzBlob, "passport-mrz.jpg");
      formData.append("source", "tight_mrz");
      formData.append("reservation_id", resId);
      formData.append("guest_index", "0");
      const res = await fetch("/api/checkin/scan-passport", { method: "POST", body: formData });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Passport scan failed.");
      }
      const scanData = json.data;

      if (scanData.mrz_failed || !scanData.parsed) {
        setMainScanId(scanData.scan_id);
        sessionStorage.removeItem("mobile-checkin-temp-ocr");
        setSavedNotice("Passport photo saved. MRZ could not be read; enter the details manually or scan again.");
        return;
      }
      const ocrName = `${scanData.parsed.firstName ?? ""} ${scanData.parsed.familyName ?? ""}`.trim();
      const currentName = mainGuest.full_name.trim() || originalBookingName;

      if (currentName && ocrName && ocrName.toLowerCase() !== currentName.toLowerCase()) {
        setBookingNameNote(`จองมาในชื่อ ${currentName}`);
      }

      setMainGuest({
        full_name: ocrName || mainGuest.full_name,
        passport_no: scanData.parsed.passportNumber || mainGuest.passport_no,
        nationality: scanData.parsed.nationality || mainGuest.nationality,
        date_of_birth: scanData.parsed.dateOfBirth || mainGuest.date_of_birth,
        gender: scanData.parsed.gender || mainGuest.gender,
      });
      setMainScanId(scanData.scan_id);

      sessionStorage.setItem("mobile-checkin-temp-ocr", JSON.stringify({
        scan_id: scanData.scan_id,
        parsed: scanData.parsed,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scan failed. Please try again.";
      alert(message);
    } finally {
      setMainScanning(false);
      if (mainCameraRef.current) mainCameraRef.current.value = "";
    }
  };

  const handleAccompanyingScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const idx = accScanning;
    if (!file || idx == null) return;
    if (!file.type.startsWith("image/") || file.size > PASSPORT_OCR_MAX_FILE_BYTES) {
      alert("Please upload a valid image under 10MB.");
      setAccScanning(null);
      return;
    }
    const guestSlot = companionSlot(accompanying[idx], idx);
    accScanSlotRef.current = guestSlot;
    try {
      const mrzBlob = await buildPassportMrzBlob(file);
      const formData = new FormData();
      formData.append("image", mrzBlob, "passport-mrz.jpg");
      formData.append("source", "tight_mrz");
      formData.append("reservation_id", resId);
      formData.append("guest_index", String(guestSlot));
      const res = await fetch("/api/checkin/scan-passport", { method: "POST", body: formData });
      const json = await res.json().catch(() => null);
      if (accScanSlotRef.current !== guestSlot) return;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Passport scan failed.");
      }
      const scanData = json.data;

      if (scanData.mrz_failed || !scanData.parsed) {
        setAccompanying(current => normalizeCompanions(current).map((guest, index) => guest.passport_guest_index === guestSlot ? { ...guest, passport_scan_id: scanData.scan_id } : guest));
        setSavedNotice("Passport photo saved. MRZ could not be read; enter the details manually or scan again.");
        return;
      }
      const parsed = scanData.parsed;
      const ocrName = `${parsed.firstName ?? ""} ${parsed.familyName ?? ""}`.trim();

      setAccompanying(current => normalizeCompanions(current).map(guest =>
        guest.passport_guest_index === guestSlot ? {
          ...guest,
          passport_scan_id: scanData.scan_id,
          full_name: ocrName || guest.full_name,
          passport_no: parsed.passportNumber || guest.passport_no || "",
          nationality: parsed.nationality || guest.nationality || "",
          date_of_birth: parsed.dateOfBirth || guest.date_of_birth || "",
          gender: parsed.gender || guest.gender || "",
          source: "ocr",
        } : guest
      ));

      const missing: string[] = [];
      if (!ocrName) missing.push("Name");
      if (!parsed.passportNumber) missing.push("Passport No.");
      if (!parsed.nationality) missing.push("Nationality");
      if (!parsed.dateOfBirth) missing.push("DOB");
      if (!parsed.gender) missing.push("Gender");
      if (missing.length > 0) {
        setAccOcrWarnings(prev => new Map(prev).set(guestSlot, missing));
      } else {
        setAccOcrWarnings(prev => { const m = new Map(prev); m.delete(guestSlot); return m; });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scan failed. Please try again.";
      alert(message);
    } finally {
      if (accScanSlotRef.current === guestSlot) accScanSlotRef.current = null;
      setAccScanning(null);
      if (accCameraRef.current) accCameraRef.current.value = "";
    }
  };

  const triggerAccScan = (idx: number) => {
    setAccScanning(idx);
    setTimeout(() => accCameraRef.current?.click(), 50);
  };

  const requestScan = (index: number) => {
    if (hasGuestData(index < 0 ? mainGuest : accompanying[index], index < 0 ? mainScanId : null)) {
      setOverwriteTarget(index);
      return;
    }
    if (index < 0) mainCameraRef.current?.click();
    else triggerAccScan(index);
  };

  const confirmRemoval = () => {
    if (removeTarget === null) return;
    const currentParty = normalizeCompanions(accompanying);
    if (accScanSlotRef.current === currentParty[removeTarget]?.passport_guest_index) accScanSlotRef.current = null;
    const remaining = currentParty.filter((_, index) => index !== removeTarget);
    setAccompanying(remaining);
    setAccOcrWarnings(new Map());
    setRemoveTarget(null);
    const key = `mobile-checkin-${resId}`;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(sessionStorage.getItem(key) || "{}"); } catch { /* Corrupt stored session. */ }
    sessionStorage.setItem(key, JSON.stringify({ ...current, accompanying_guests: remaining, accompanying: remaining }));
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-muted)] pb-24">
      {/* Header & Step Indicator */}
      <header className="px-6 py-4 border-b border-[var(--border-default)] bg-[var(--bg-surface)] sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.back()}
            className="p-3 -ml-3 rounded-full hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] transition"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-brand-600 tracking-wider">STEP 1/3</span>
            <h1 className="text-xl font-bold tracking-tight">Guest Info</h1>
          </div>
        </div>
      </header>

      {loadingName ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="w-8 h-8 border-4 border-[var(--border-default)] border-t-brand-500 rounded-full animate-spin"></span>
        </div>
      ) : (
        <>
          <main className="flex-1 p-6 space-y-6">
            {isDraftFromUrl && (
          <div className="bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-500/30 rounded-xl p-4 flex gap-3 shadow-sm">
            <ShieldAlert className="w-6 h-6 text-amber-600 dark:text-amber-500 shrink-0" />
            <div>
               <p className="text-sm font-bold text-amber-800 dark:text-amber-300 uppercase">Draft Mode Active</p>
               <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mt-1">
                 Booking นี้เคยถูกบันทึกเป็น draft มาก่อน แต่ถ้าข้อมูลครบแล้ว confirm รอบนี้จะเปลี่ยนเป็น active ได้
               </p>
            </div>
          </div>
        )}

        {/* Main Guest Form */}
        <section className="bg-[var(--bg-surface)] rounded-2xl shadow-sm border border-[var(--border-default)] overflow-hidden">
          <div className="bg-brand-50/50 dark:bg-[var(--bg-surface-hover)] px-5 py-3 border-b border-[var(--border-default)] flex justify-between items-center">
            <h2 className="font-bold text-brand-700 dark:text-brand-400">Main Guest</h2>
            <div className="flex items-center gap-2">
              {mainScanId && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full uppercase">
                  <Camera className="w-3 h-3" /> OCR
                </span>
              )}
              <button
                type="button"
                onClick={() => requestScan(-1)}
                disabled={mainScanning}
                className="inline-flex items-center gap-1 text-xs font-bold bg-brand-100 dark:bg-brand-500/20 text-brand-700 dark:text-brand-400 px-3 py-1.5 rounded-full hover:bg-brand-200 dark:hover:bg-brand-500/30 transition disabled:opacity-50"
              >
                {mainScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
                {mainScanning ? "Scanning..." : "Scan Passport"}
              </button>
              <input
                ref={mainCameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleMainGuestScan}
              />
            </div>
          </div>
          
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Full Name</label>
              <input
                value={mainGuest.full_name}
                onChange={(e) => setMainGuest({...mainGuest, full_name: e.target.value})}
                className="w-full h-12 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-[var(--text-primary)] focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                placeholder="Required"
              />
              {bookingNameNote && (
                <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                  📋 {bookingNameNote}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Passport No.</label>
                <input 
                  value={mainGuest.passport_no}
                  onChange={(e) => setMainGuest({...mainGuest, passport_no: e.target.value})}
                  className="w-full h-12 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-[var(--text-primary)] focus:ring-2 focus:ring-brand-500"
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Nationality</label>
                <input 
                  value={mainGuest.nationality}
                  onChange={(e) => setMainGuest({...mainGuest, nationality: e.target.value})}
                  className="w-full h-12 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-[var(--text-primary)] focus:ring-2 focus:ring-brand-500 uppercase"
                  placeholder="Ex: FRA"
                />
              </div>
            </div>

            {(profileLookupLoading || profileCandidate || profileLookupError) && (
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-muted)] p-3 space-y-2">
                {profileLookupLoading && (
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    กำลังค้นหาโปรไฟล์เดิม...
                  </div>
                )}

                {!profileLookupLoading && profileLookupError && (
                  <p className="text-xs font-semibold text-rose-500">{profileLookupError}</p>
                )}

                {!profileLookupLoading && profileCandidate && (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                      พบโปรไฟล์เดิมในระบบ
                    </p>
                    <div className="rounded-lg border border-emerald-300/40 bg-emerald-50/50 dark:bg-emerald-500/10 p-2.5">
                      <p className="text-sm font-bold text-[var(--text-primary)]">
                        {composeProfileName(profileCandidate) || "-"}
                      </p>
                      <p className="text-xs font-semibold text-[var(--text-secondary)]">
                        Passport: {profileCandidate.passport_no || profileCandidate.id_number || "-"}
                        {" · "}
                        Nation: {profileCandidate.nationality_code || "-"}
                      </p>
                      {profileCandidate.phone && (
                        <p className="text-xs font-semibold text-[var(--text-secondary)] mt-0.5">
                          Phone: {profileCandidate.phone}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={useExistingProfile}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                          selectedProfileId === profileCandidate.id
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200"
                        }`}
                      >
                        {selectedProfileId === profileCandidate.id ? "เลือกโปรไฟล์นี้แล้ว" : "ใช้โปรไฟล์นี้"}
                      </button>
                      {selectedProfileId && selectedProfileId === profileCandidate.id && (
                        <button
                          type="button"
                          onClick={() => setSelectedProfileId(null)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--border-input)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] transition"
                        >
                          ยกเลิกการเลือก
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">DOB</label>
                <input 
                  type="date"
                  value={mainGuest.date_of_birth}
                  onChange={(e) => setMainGuest({...mainGuest, date_of_birth: e.target.value})}
                  className="w-full h-12 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-[var(--text-primary)] focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Gender</label>
                <select 
                  value={mainGuest.gender}
                  onChange={(e) => setMainGuest({...mainGuest, gender: e.target.value})}
                  className="w-full h-12 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-[var(--text-primary)] focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">-Select-</option>
                  <option value="M">Male (M)</option>
                  <option value="F">Female (F)</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* Accompanying Guests */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider">Accompanying ({accompanying.length}/3)</h3>
          </div>

          {accompanying.map((acc, idx) => (
            <div key={idx} className="bg-[var(--bg-surface)] rounded-2xl shadow-sm border border-[var(--border-default)] overflow-hidden">
              <div className="px-5 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-muted)] flex justify-between items-center">
                <span className="text-xs font-bold text-[var(--text-muted)] uppercase">Guest {companionSlot(acc, idx)}</span>
                <div className="flex items-center gap-2">
                  {acc.source === "ocr" && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full uppercase">
                      <Camera className="w-3 h-3" /> OCR
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => requestScan(idx)}
                    disabled={accScanning != null}
                    className="inline-flex items-center gap-1 text-[10px] font-bold bg-brand-100 dark:bg-brand-500/20 text-brand-700 dark:text-brand-400 px-2 py-1 rounded-full hover:bg-brand-200 transition disabled:opacity-50"
                  >
                    {accScanning === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
                    Scan
                  </button>
                  <button
                    onClick={() => removeAccompanying(idx)}
                    className="text-rose-500 hover:text-rose-600 p-1 rounded-full transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {accOcrWarnings.has(companionSlot(acc, idx)) && (
                <div className="mx-5 mt-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/30 rounded-lg p-2.5 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                    OCR ไม่ครบ กรุณาตรวจสอบ: {accOcrWarnings.get(companionSlot(acc, idx))!.join(", ")}
                  </p>
                </div>
              )}

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Name</label>
                  <input
                    value={acc.full_name}
                    onChange={(e) => updateAccompanying(idx, "full_name", e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-sm focus:ring-2 focus:ring-brand-500"
                    placeholder="Guest Name"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Passport No.</label>
                    <input
                      value={acc.passport_no || ""}
                      onChange={(e) => updateAccompanying(idx, "passport_no", e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-sm focus:ring-2 focus:ring-brand-500"
                      placeholder="Optional"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] uppercase mb-1">Nationality</label>
                    <input
                      value={acc.nationality || ""}
                      onChange={(e) => updateAccompanying(idx, "nationality", e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] text-sm focus:ring-2 focus:ring-brand-500 uppercase"
                      placeholder="Ex: FRA"
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Hidden file input for accompanying guest scans */}
          <input
            ref={accCameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleAccompanyingScan}
          />

          {accompanying.length < 3 && (
            <button 
              onClick={addAccompanying}
              className="w-full h-14 border-2 border-dashed border-[var(--border-input)] rounded-2xl text-[var(--text-secondary)] font-bold uppercase tracking-wide flex items-center justify-center gap-2 hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)] transition active:scale-[0.98]"
            >
              <Plus className="w-5 h-5" /> Add Accompanying Guest
            </button>
          )}
          </section>
        </main>

        <div className="fixed bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--bg-muted)] to-transparent pointer-events-none">
          <div className="max-w-lg mx-auto pointer-events-auto">
            <button
              onClick={onNext}
              className="w-full h-14 bg-brand-600 text-white rounded-2xl font-black tracking-widest uppercase shadow-xl shadow-brand-500/30 active:scale-[0.98] transition-all flex items-center justify-center"
            >
              Next <ArrowLeft className="w-6 h-6 ml-2 rotate-180" />
            </button>
          </div>
        </div>
        </>
      )}
      {overwriteTarget !== null && (
        <div role="dialog" aria-modal="true" aria-label="Confirm passport overwrite" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="rounded-xl bg-[var(--bg-surface)] p-6 space-y-4">
            <p>Scanning again will replace this guest's details. Continue?</p>
            <button type="button" className="btn btn-secondary" onClick={() => setOverwriteTarget(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => {
              const index = overwriteTarget; setOverwriteTarget(null);
              if (index < 0) mainCameraRef.current?.click(); else triggerAccScan(index);
            }}>Scan again</button>
          </div>
        </div>
      )}
      {removeTarget !== null && (
        <div role="dialog" aria-modal="true" aria-label="Confirm guest removal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="rounded-xl bg-[var(--bg-surface)] p-6 space-y-4">
            <p>Delete this accompanying guest?</p>
            <button type="button" className="btn btn-secondary" onClick={() => setRemoveTarget(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={confirmRemoval}>Delete guest</button>
          </div>
        </div>
      )}
      {savedNotice && <div role="status" className="fixed bottom-24 inset-x-4 rounded-xl bg-amber-100 p-4 text-amber-900" onClick={() => setSavedNotice(null)}>{savedNotice}</div>}
    </div>
  );
}
