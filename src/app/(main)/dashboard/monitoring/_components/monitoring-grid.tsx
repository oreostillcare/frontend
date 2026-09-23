"use client";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { useTelemetry } from "@/hooks/use-telemetry";
import { videoUrl } from "@/lib/api/client";
import type { CameraStatus } from "@/lib/api/types";

function CameraCard({ camera, id }: { camera?: CameraStatus; id: number }) {
  const [streamError, setStreamError] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const mirror = id === 2 && camera?.testMirror;
  const url = videoUrl(id);
  const cameraOnline = Boolean(camera?.online);
  let status: "LIVE" | "OFFLINE" | "RETRYING" | "TEST MIRROR" = "OFFLINE";
  let statusVariant: "secondary" | "destructive" | "outline" = "destructive";
  if (mirror) {
    status = "TEST MIRROR";
    statusVariant = "outline";
  } else if (cameraOnline && streamError) {
    status = "RETRYING";
    statusVariant = "outline";
  } else if (cameraOnline) {
    status = "LIVE";
    statusVariant = "secondary";
  }

  useEffect(() => {
    if (!streamError || !cameraOnline) return;
    const retryTimer = window.setTimeout(() => {
      setStreamAttempt((attempt) => attempt + 1);
      setStreamError(false);
    }, 2000);
    return () => window.clearTimeout(retryTimer);
  }, [cameraOnline, streamError]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Camera {id === 1 ? "A" : "B"} / Lane {id === 1 ? "A" : "B"}
        </CardTitle>
        <CardDescription>
          {mirror ? "Camera A mirror · shared YOLO worker" : "YOLO + ByteTrack processed feed"}
        </CardDescription>
        <CardAction>
          <Badge variant={statusVariant}>{status}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {cameraOnline && !streamError ? (
          <div className="aspect-video overflow-hidden rounded-lg bg-muted">
            <img
              className="size-full object-contain"
              src={`${url}?attempt=${streamAttempt}`}
              alt={`Processed traffic feed for Camera ${id}`}
              onError={() => setStreamError(true)}
            />
          </div>
        ) : (
          <Empty className="aspect-video">
            <EmptyHeader>
              <EmptyTitle>{cameraOnline ? "Stream reconnecting" : "Camera offline"}</EmptyTitle>
              <EmptyDescription>
                {cameraOnline
                  ? "The stream is reconnecting automatically."
                  : "The camera or detection backend is currently unavailable."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">FPS</p>
            <p className="font-medium">{camera?.fps ?? "--"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Visible</p>
            <p className="font-medium">{camera?.visibleVehicles ?? "--"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Frame age</p>
            <p className="font-medium">{camera?.frameAgeMs == null ? "--" : `${camera.frameAgeMs} ms`}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Tracker</p>
            <p className="font-medium">{camera?.tracker ?? "--"}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
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
            ? "Two-view load test. Camera B mirrors Camera A without a second RTSP or inference worker."
            : "Two camera slots for locally processed detection feeds."}
        </p>
      </div>
      {error && <Badge variant="destructive">Reconnecting to detection backend</Badge>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {displayedCameras.map((camera, index) => {
          const cameraId = camera?.id ?? index + 1;
          return <CameraCard id={cameraId} camera={camera} key={cameraId} />;
        })}
      </div>
    </div>
  );
}
