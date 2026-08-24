"use client";
import { useCallback, useEffect, useState } from "react";

import { getCameras } from "@/lib/api/cameras";
import { getSystemStatus } from "@/lib/api/system";
import type { CameraStatus, SystemStatus } from "@/lib/api/types";

export function useTelemetry(intervalMs = 2000) {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [cameras, setCameras] = useState<CameraStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [nextSystem, nextCameras] = await Promise.all([getSystemStatus(), getCameras()]);
      setSystem(nextSystem);
      setCameras(nextCameras);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telemetry unavailable");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, refresh]);
  return { system, cameras, loading, error, refresh };
}
