"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hashSHA256 } from "@/lib/crypto";
import {
  OfflineArrivals,
  OfflineDepartures,
  OfflineInHouse,
  OfflineRoomStatus,
} from "@/components/backup/offline-data-components";

type OfflineSnapshot = {
  id: string;
  snapshot_date: string;
  record_count: number;
  created_at: string;
  snapshot_data: {
    generated_at: string;
    business_date?: string;
    date_range: { from: string; to: string };
    reservations: Array<Record<string, unknown>>;
    arrivals?: Array<Record<string, unknown>>;
    in_house?: Array<Record<string, unknown>>;
    departures?: Array<Record<string, unknown>>;
    rooms: Array<Record<string, unknown>>;
    hk_status: Array<Record<string, unknown>>;
    room_status?: Array<Record<string, unknown>>;
  };
};

type BackupConfigPublic = {
  retention_days: number;
  r2_bucket: string;
  updated_at: string;
  pin_hash: string | null;
  has_pin: boolean;
  device_pairing_required: boolean;
};

type DevicePairResponse = {
  device_id: string;
  device_name: string;
  device_token: string;
  paired_at: string;
};

type Tab = "arrivals" | "inhouse" | "departures" | "rooms";

const PIN_HASH_CACHE_KEY = "pms_offline_pin_hash";
const SNAPSHOT_CACHE_KEY = "pms_offline_snapshot";
const DEVICE_TOKEN_CACHE_KEY = "pms_offline_device_token";
const DEVICE_NAME_CACHE_KEY = "pms_offline_device_name";
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(String(json?.error ?? "Request failed."));
  }
  return json.data as T;
}

export default function OfflinePage() {
  const [isLocked, setIsLocked] = useState(true);
  const [pin, setPin] = useState("");
  const [unlockPin, setUnlockPin] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [registeredDeviceName, setRegisteredDeviceName] = useState<string | null>(null);
  const [pairingToken, setPairingToken] = useState("");
  const [pairingDeviceName, setPairingDeviceName] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("arrivals");
  const [isOnline, setIsOnline] = useState(false);
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const lastSyncAtRef = useRef<number | null>(null);

  const isPaired = Boolean(deviceToken);

  const refreshPinCache = async (tokenOverride?: string | null) => {
    const tokenForConfig = tokenOverride ?? deviceToken;
    const headers = tokenForConfig ? { "x-offline-device-token": tokenForConfig } : undefined;
    const config = await readJson<BackupConfigPublic>(
      await fetch("/api/backup/config", { cache: "no-store", headers })
    );
    if (typeof window !== "undefined" && config.pin_hash) {
      window.localStorage.setItem(PIN_HASH_CACHE_KEY, config.pin_hash);
    }
  };

  useEffect(() => {
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    setIsOnline(online);

    if (typeof window !== "undefined") {
      const savedSnapshot = window.localStorage.getItem(SNAPSHOT_CACHE_KEY);
      if (savedSnapshot) {
        try {
          setSnapshot(JSON.parse(savedSnapshot) as OfflineSnapshot);
        } catch {
          window.localStorage.removeItem(SNAPSHOT_CACHE_KEY);
        }
      }
      setDeviceToken(window.localStorage.getItem(DEVICE_TOKEN_CACHE_KEY));
      setRegisteredDeviceName(window.localStorage.getItem(DEVICE_NAME_CACHE_KEY));
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;

    (async () => {
      try {
        const headers = deviceToken ? { "x-offline-device-token": deviceToken } : undefined;
        const config = await readJson<BackupConfigPublic>(
          await fetch("/api/backup/config", { cache: "no-store", headers })
        );
        if (cancelled) return;
        if (typeof window !== "undefined" && config.pin_hash) {
          window.localStorage.setItem(PIN_HASH_CACHE_KEY, config.pin_hash);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setSyncMessage(fetchError instanceof Error ? fetchError.message : "Failed to refresh PIN cache.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOnline, deviceToken]);

  const syncSnapshot = async (providedPin: string, options?: { silent?: boolean }) => {
    if (!providedPin) return;
    if (!deviceToken) {
      setError("This device has not been paired yet.");
      return;
    }
    if (!options?.silent) {
      setError(null);
      setSyncMessage(null);
    }
    setIsSyncing(true);
    try {
      const data = await readJson<OfflineSnapshot>(
        await fetch("/api/backup/snapshot", {
          cache: "no-store",
          headers: {
            "x-offline-pin": providedPin,
            "x-offline-device-token": deviceToken,
          },
        })
      );
      setSnapshot(data);
      lastSyncAtRef.current = Date.now();
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(data));
      }
      setSyncMessage("Snapshot synced successfully.");
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "Failed to sync snapshot.";
      if (!options?.silent) {
        setError(message);
      } else {
        setSyncMessage(message);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (!isOnline || isLocked || !unlockPin) return;
    void syncSnapshot(unlockPin, { silent: true });

    const interval = window.setInterval(() => {
      void syncSnapshot(unlockPin, { silent: true });
    }, SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [deviceToken, isLocked, isOnline, unlockPin]);

  const handlePairDevice = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSyncMessage(null);

    if (!isOnline) {
      setError("This device must be online for first-time pairing.");
      return;
    }

    setIsPairing(true);
    try {
      const data = await readJson<DevicePairResponse>(
        await fetch("/api/backup/device-pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairing_token: pairingToken,
            device_name: pairingDeviceName.trim() || undefined,
          }),
        })
      );

      if (typeof window !== "undefined") {
        window.localStorage.setItem(DEVICE_TOKEN_CACHE_KEY, data.device_token);
        window.localStorage.setItem(DEVICE_NAME_CACHE_KEY, data.device_name);
      }

      setDeviceToken(data.device_token);
      setRegisteredDeviceName(data.device_name);
      setPairingToken("");
      setPairingDeviceName(data.device_name);
      await refreshPinCache(data.device_token);
      setSyncMessage(`Device paired as ${data.device_name}. Enter the offline PIN to continue.`);
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "Failed to pair this device.");
    } finally {
      setIsPairing(false);
    }
  };

  const handleUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!deviceToken) {
      setError("This device must be paired before offline access is allowed.");
      return;
    }

    const cachedPinHash =
      typeof window !== "undefined" ? window.localStorage.getItem(PIN_HASH_CACHE_KEY) : null;

    if (!cachedPinHash) {
      setError("PIN has not been cached on this device yet. Connect online once from the admin screen first.");
      return;
    }

    const inputHash = await hashSHA256(pin);
    if (inputHash !== cachedPinHash) {
      setError("Incorrect PIN");
      setPin("");
      return;
    }

    setUnlockPin(pin);
    setIsLocked(false);
    if (isOnline) {
      await syncSnapshot(pin, { silent: true });
    }
    setPin("");
  };

  const handleLock = () => {
    setIsLocked(true);
    setUnlockPin(null);
  };

  const generatedAt = snapshot?.snapshot_data.generated_at ?? null;
  const formattedGeneratedAt = generatedAt
    ? new Date(generatedAt).toLocaleString("th-TH", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "No data";

  const nextAttemptText = useMemo(() => {
    if (!lastSyncAtRef.current) return "after unlock";
    return new Date(lastSyncAtRef.current + SYNC_INTERVAL_MS).toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [snapshot?.id, isOnline]);

  if (isLocked) {
    if (!isPaired) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--bg-body)] p-4">
          <div className="card w-full max-w-md space-y-6 p-8 text-center shadow-xl">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sky-100 text-sky-600">
              <LockIcon />
            </div>
            <div>
              <h2 className="text-xl font-bold">Pair This Device First</h2>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                Enter the one-time pairing token from the Backup page. After pairing, this browser becomes an allowed
                offline device and can use the normal PIN flow.
              </p>
            </div>

            <form onSubmit={handlePairDevice} className="space-y-4 text-left">
              <div>
                <label className="form-label">Device Label</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="FO Front Desk PC"
                  value={pairingDeviceName}
                  onChange={(event) => setPairingDeviceName(event.target.value)}
                  disabled={isPairing}
                />
              </div>
              <div>
                <label className="form-label">Pairing Token</label>
                <input
                  type="text"
                  className="form-input font-mono"
                  placeholder="Paste token from Backup page"
                  value={pairingToken}
                  onChange={(event) => setPairingToken(event.target.value.trim())}
                  disabled={isPairing}
                  autoFocus
                />
              </div>

              {error ? <p className="text-sm font-medium text-rose-500">{error}</p> : null}
              {syncMessage ? <p className="text-sm font-medium text-emerald-500">{syncMessage}</p> : null}

              <button
                type="submit"
                className="btn-primary h-12 w-full text-lg"
                disabled={!isOnline || isPairing || pairingToken.length < 8}
              >
                {isPairing ? "Pairing..." : "Pair This Device"}
              </button>
            </form>

            <div className="border-t pt-4 text-[10px] text-[var(--text-muted)]">
              System Status: {isOnline ? "Online" : "Offline"} | Pairing requires an online connection
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-body)] p-4">
        <div className="card w-full max-w-sm space-y-6 p-8 text-center shadow-xl">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <LockIcon />
          </div>
          <div>
            <h2 className="text-xl font-bold">Offline Access Required</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Enter your 4-digit PIN to access the emergency viewer on{" "}
              <strong>{registeredDeviceName ?? "this paired device"}</strong>.
            </p>
          </div>
          <form onSubmit={handleUnlock} className="space-y-4">
            <input
              type="password"
              maxLength={4}
              placeholder="••••"
              className="form-input h-16 text-center font-mono text-3xl tracking-[1rem]"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
            {error ? <p className="text-sm font-medium text-rose-500">{error}</p> : null}
            <button type="submit" className="btn-primary h-12 w-full text-lg" disabled={pin.length !== 4}>
              Unlock Data
            </button>
          </form>
          <div className="border-t pt-4 text-[10px] text-[var(--text-muted)]">
            System Status: {isOnline ? "Online" : "Offline"} | Device: {registeredDeviceName ?? "Paired"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg-body)]">
      <div
        className={`flex items-center justify-center gap-2 p-4 text-center text-sm font-bold ${
          isOnline ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
        }`}
      >
        {isOnline ? <span>ONLINE MODE — Sync available</span> : <span>OFFLINE MODE — Data as of {formattedGeneratedAt}</span>}
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col space-y-6 p-4 md:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Emergency Operations Viewer</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Read-only operational data for front desk use during connectivity or Supabase outages.
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Paired device: <strong>{registeredDeviceName ?? "Unknown device"}</strong>
            </p>
          </div>
          <button onClick={handleLock} className="btn-secondary btn-sm">
            Lock Session
          </button>
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700 dark:border-rose-900/30 dark:bg-rose-950/20 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        {syncMessage ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-5 py-4 text-sm text-sky-700 dark:border-sky-900/30 dark:bg-sky-950/20 dark:text-sky-200">
            {syncMessage}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3 text-sm">
          <span>
            Connection Status: <strong>{isOnline ? "Online" : "Offline"}</strong>
          </span>
          <span>
            Last Sync: <strong>{formattedGeneratedAt}</strong>
          </span>
          <span>
            Next attempt: <strong>{isOnline ? nextAttemptText : "when online"}</strong>
          </span>
          <button
            onClick={() => (unlockPin ? void syncSnapshot(unlockPin) : undefined)}
            disabled={!isOnline || !unlockPin || isSyncing}
            className="btn-primary btn-sm ml-auto"
          >
            {isSyncing ? "Syncing..." : "Try Sync Now"}
          </button>
        </div>

        <div className="flex border-b border-[var(--border-default)]">
          {(["arrivals", "inhouse", "departures", "rooms"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-4 py-3 text-sm font-bold capitalize transition-colors ${
                activeTab === tab
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {tab.replace("inhouse", "In-House")}
            </button>
          ))}
        </div>

        <div className="flex-1">
          {snapshot ? (
            <>
              {activeTab === "arrivals" ? <OfflineArrivals data={snapshot.snapshot_data} /> : null}
              {activeTab === "inhouse" ? <OfflineInHouse data={snapshot.snapshot_data} /> : null}
              {activeTab === "departures" ? <OfflineDepartures data={snapshot.snapshot_data} /> : null}
              {activeTab === "rooms" ? <OfflineRoomStatus data={snapshot.snapshot_data} /> : null}
            </>
          ) : (
            <div className="card p-8 text-center text-sm text-[var(--text-muted)]">
              No cached snapshot yet. Unlock with a valid PIN and sync once while online.
            </div>
          )}
        </div>

        <div className="border-t pb-4 pt-8 text-center text-xs text-[var(--text-muted)]">
          <p>This viewer reads the latest cached operational snapshot stored on this device.</p>
          <p className="mt-1">Last cached snapshot ID: {snapshot?.id || "None"}</p>
        </div>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-8 w-8">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}
