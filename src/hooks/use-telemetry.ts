"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { getSystemStatus } from "@/lib/api/system";
import type { CameraStatus, SystemStatus } from "@/lib/api/types";

export function useTelemetry(intervalMs = 2000) {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [cameras, setCameras] = useState<CameraStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Other async refreshes mutate this ref.
    if (pending.current) return pending.current;
    const request = (async () => {
      try {
        const nextSystem = await getSystemStatus();
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Effect cleanup can run while awaiting the request.
        if (!mounted.current) return;
        setSystem(nextSystem);
        setCameras(nextSystem.cameras ?? []);
        setError(null);
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : "Telemetry unavailable");
      } finally {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The effect controls this ref across async boundaries.
        if (mounted.current) setLoading(false);
      }
    })();
    pending.current = request;
    try {
      await request;
    } finally {
      pending.current = null;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh]);
  return { system, cameras, loading, error, refresh };
}
