"use client";

// Composes both camera cards with the live map and node session-log panels.

import { Badge } from "@/components/ui/badge";
import { useTelemetry } from "@/modules/offline-connectivity/telemetry-status-hook";
import type { CameraStatus } from "@/modules/offline-connectivity/api/telemetry-api-types";
import { LiveMap } from "@/modules/live-maps/node-location-map";
import { SessionLogs } from "@/modules/node-session-logs/node-session-log-table";

import { CameraCard } from "./camera-card";

export function MonitoringGrid() {
  const { cameras, error } = useTelemetry();
  const hasTestMirror = cameras.some((camera) => camera.testMirror);
  const displayedCameras: Array<CameraStatus | undefined> = cameras.length ? cameras : [undefined, undefined];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-3xl leading-none tracking-tight">Live Monitoring</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {hasTestMirror
            ? "Camera B is a test-only display mirror. Its traffic status and counts remain inactive; signal actuation is disabled."
            : "Raw camera views. Detection, tracking and counting continue in the shared local backend."}
        </p>
      </div>
      {error && <Badge variant="destructive">Reconnecting to detection backend</Badge>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {displayedCameras.map((camera, index) => {
          const cameraId = camera?.id ?? index + 1;
          return <CameraCard id={cameraId} camera={camera} key={cameraId} />;
        })}
      </div>
      <LiveMap />
      <SessionLogs />
    </div>
  );
}
