"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Info, Loader2, Search, X } from "lucide-react";
import { compressImageForUpload } from "@/lib/client-image-compression";
import { LF_DRAFT_KEY, parseLfDraft, serializeLfDraft } from "./lf-report-draft";

interface ReportRoom {
  id: string;
  room_number: string;
  guest_name: string | null;
  reservation_id: string | null;
}

interface LfReportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onReopen?: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  general: "ทั่วไป",
  electronics: "อุปกรณ์ไฟฟ้า",
  clothing: "เสื้อผ้า",
  documents: "เอกสาร",
  valuables: "ของมีค่า",
  other: "อื่นๆ",
};

export default function LfReportSheet({ isOpen, onClose, onSuccess, onReopen }: LfReportSheetProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<ReportRoom[]>([]);

  const [roomId, setRoomId] = useState("");
  const [description, setDescription] = useState("");
  const [locationDetail, setLocationDetail] = useState("");
  const [category, setCategory] = useState("general");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/lost-found/rooms", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.rooms)) {
          setRooms(data.rooms);
        } else {
          setRooms([]);
        }
      })
      .catch(() => setRooms([]));
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  useEffect(() => {
    try {
      const draft = parseLfDraft(window.localStorage.getItem(LF_DRAFT_KEY), Date.now());
      if (!draft) return;
      setRoomId(draft.roomId);
      setDescription(draft.description);
      setLocationDetail(draft.locationDetail);
      setCategory(draft.category);
      onReopen?.();
    } catch { /* Storage can be unavailable in a private browsing context. */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    try {
      window.localStorage.setItem(LF_DRAFT_KEY, serializeLfDraft({
        roomId, description, locationDetail, category, createdItemId: null, photoPromised: false,
      }, Date.now()));
    } catch { /* The form remains usable if persistent storage is unavailable. */ }
  }, [isOpen, roomId, description, locationDetail, category]);

  const resetState = () => {
    setRoomId("");
    setDescription("");
    setLocationDetail("");
    setCategory("general");
    setPhoto(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setError(null);
    setRooms([]);
  };

  const handleClose = () => {
    try { window.localStorage.removeItem(LF_DRAFT_KEY); } catch { /* Storage unavailable. */ }
    resetState();
    onClose();
  };

  const handlePhotoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!roomId || !description.trim()) {
      setError("กรุณาเลือกห้องและใส่รายละเอียด");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const selectedRoom = rooms.find((room) => room.id === roomId) || null;
      const roomNumber = selectedRoom?.room_number || "Unknown";

      const res = await fetch("/api/lost-found", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          description: description.trim(),
          category,
          location_detail: locationDetail.trim() || null,
          reservation_id: selectedRoom?.reservation_id ?? null,
          found_by: roomNumber ? `Maid (Room ${roomNumber})` : "Maid",
        }),
      });

      if (!res.ok) throw new Error("ไม่สามารถแจ้งรายการได้");
      const data = await res.json();
      const itemId = data.item.id;

      if (photo) {
        const resizedFile = await compressImageForUpload(photo, { maxBytes: 5 * 1024 * 1024 });
        const formData = new FormData();
        formData.append("image", resizedFile, resizedFile.name);
        formData.append("item_id", itemId);

        const uploadRes = await fetch("/api/lost-found/upload", {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const uploadJson = await uploadRes.json().catch(() => null);
          throw new Error(uploadJson?.error || "อัปโหลดรูปไม่สำเร็จ");
        }
      }

      onSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || "เกิดข้อผิดพลาด");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[150] transition-all duration-300 ${
        isOpen ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      <div
        className={`absolute inset-0 bg-slate-950/70 backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "opacity-0"
        }`}
        onClick={handleClose}
      />

      <div
        className={`absolute inset-x-0 bottom-0 top-0 flex justify-center transition-transform duration-300 ease-out ${
          isOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="relative flex h-full w-full max-w-screen-md flex-col overflow-hidden rounded-t-[32px] border border-slate-200 shadow-[0_-18px_40px_rgba(15,23,42,0.25)] dark:border-white/5 dark:bg-slate-950">
          <div className="pointer-events-none absolute inset-0 dark:hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.24),transparent_28%),radial-gradient(circle_at_top_right,rgba(249,115,22,0.16),transparent_24%),radial-gradient(circle_at_50%_100%,rgba(245,158,11,0.12),transparent_30%),linear-gradient(180deg,#e7dfd4_0%,#efe7dc_34%,#f6f0e7_100%)]" />
            <div className="absolute inset-0 opacity-28 [background-image:linear-gradient(rgba(255,255,255,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:26px_26px]" />
            <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(255,255,255,0.3),transparent)]" />
          </div>

          <div className="flex justify-center pt-3">
            <div className="h-1.5 w-14 rounded-full bg-slate-300 dark:bg-white/15" />
          </div>

          <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 px-4 pb-4 pt-3 backdrop-blur-xl dark:border-white/5 dark:bg-slate-950/95">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg shadow-amber-500/20">
                  <Search size={24} />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.24em] text-slate-400 dark:text-slate-500">
                    แจ้งรายการ
                  </p>
                  <h2 className="mt-1 text-2xl font-black text-slate-900 dark:text-white">แจ้งพบของลืม</h2>
                </div>
              </div>

              <button
                type="button"
                onClick={handleClose}
                className="rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X size={22} />
              </button>
            </div>
          </div>

          <div className="relative z-10 flex-1 overflow-y-auto px-4 pb-36 pt-4">
            <div className="rounded-[28px] border border-amber-200 bg-[linear-gradient(180deg,rgba(255,247,237,0.98),rgba(254,243,199,0.78))] p-4 shadow-sm dark:border-amber-500/20 dark:bg-none dark:bg-amber-500/10">
              <div className="flex gap-3">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" />
                <p className="text-sm font-bold leading-relaxed text-amber-700 dark:text-amber-300">
                  หากพบสิ่งของที่ลูกค้าลืมไว้ กรุณาถ่ายภาพและใส่รายละเอียดเพื่อแจ้ง Front Desk ทันที
                </p>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-[24px] border border-rose-200 bg-[linear-gradient(180deg,rgba(255,241,242,0.98),rgba(255,228,230,0.84))] px-4 py-3 text-sm font-black text-rose-700 dark:border-rose-500/20 dark:bg-none dark:bg-rose-500/10 dark:text-rose-300">
                {error}
              </div>
            )}

            <form id="lf-report-form" onSubmit={handleSubmit} className="mt-6 space-y-6">
              <div>
                <label className="mb-2 block text-base font-black text-slate-800 dark:text-slate-200">
                  พบที่ห้องไหน? <span className="text-rose-500">*</span>
                </label>
                <select
                  className="w-full appearance-none rounded-[24px] border border-amber-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(255,251,235,0.92))] px-4 py-4 text-base font-bold text-slate-900 outline-none transition focus:border-amber-400 dark:border-white/10 dark:bg-none dark:bg-slate-900 dark:text-white"
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                  required
                >
                  <option value="" disabled>
                    เลือกห้อง...
                  </option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      ห้อง {room.room_number}
                      {room.guest_name ? ` - ${room.guest_name}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-base font-black text-slate-800 dark:text-slate-200">
                  ถ่ายรูป <span className="font-normal text-slate-400 dark:text-slate-500">(ไม่บังคับแต่แนะนำ)</span>
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handlePhotoChange}
                />

                {photoPreview ? (
                  <div className="relative overflow-hidden rounded-[28px] border border-amber-100 bg-black shadow-sm dark:border-white/5">
                    <img src={photoPreview} alt="ตัวอย่างรูป" className="aspect-video w-full object-contain" />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-2xl bg-black/60 px-4 py-3 text-sm font-black text-white backdrop-blur-md"
                    >
                      <Camera size={18} />
                      ถ่ายใหม่
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-video w-full flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-amber-300 bg-[linear-gradient(180deg,rgba(255,247,237,0.98),rgba(254,243,199,0.72))] text-amber-600 transition-colors hover:bg-amber-100 dark:border-amber-500/20 dark:bg-none dark:bg-amber-500/10 dark:text-amber-300"
                  >
                    <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-amber-200 dark:bg-amber-500/15">
                      <Camera className="h-7 w-7" />
                    </div>
                    <span className="text-xl font-black">กดเพื่อถ่ายรูป</span>
                  </button>
                )}
              </div>

              <div>
                <label className="mb-2 block text-base font-black text-slate-800 dark:text-slate-200">
                  รายละเอียด <span className="text-rose-500">*</span>
                </label>
                <textarea
                  className="min-h-[120px] w-full resize-none rounded-[24px] border border-amber-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(255,251,235,0.92))] px-4 py-4 text-base font-bold text-slate-900 outline-none transition focus:border-amber-400 dark:border-white/10 dark:bg-none dark:bg-slate-900 dark:text-white"
                  placeholder="เช่น กระเป๋าสตางค์สีดำ สายชาร์จ โทรศัพท์ หรือกุญแจ"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-base font-black text-slate-800 dark:text-slate-200">
                    หมวดหมู่
                  </label>
                  <select
                    className="w-full appearance-none rounded-[24px] border border-amber-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(255,251,235,0.92))] px-4 py-4 text-base font-bold text-slate-900 outline-none transition focus:border-amber-400 dark:border-white/10 dark:bg-none dark:bg-slate-900 dark:text-white"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-base font-black text-slate-800 dark:text-slate-200">
                    จุดที่พบ
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-[24px] border border-amber-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(255,251,235,0.92))] px-4 py-4 text-base font-bold text-slate-900 outline-none transition focus:border-amber-400 dark:border-white/10 dark:bg-none dark:bg-slate-900 dark:text-white"
                    placeholder="เช่น ใต้หมอน"
                    value={locationDetail}
                    onChange={(event) => setLocationDetail(event.target.value)}
                  />
                </div>
              </div>
            </form>
          </div>

          <div className="absolute inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/78 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/90">
            <button
              type="submit"
              form="lf-report-form"
              disabled={isSubmitting}
              className="flex h-16 w-full items-center justify-center gap-2 rounded-[20px] bg-amber-500 text-xl font-black text-white shadow-[0_10px_24px_rgba(245,158,11,0.25)] transition-colors hover:bg-amber-600 disabled:opacity-60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={22} className="animate-spin" />
                  กำลังส่ง
                </>
              ) : (
                "แจ้งพบของลืม"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
