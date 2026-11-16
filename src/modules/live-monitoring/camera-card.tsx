"use client";

// Displays one camera feed with availability, FPS, frame age, and tracker status.

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { rawVideoUrl, videoUrl } from "@/modules/offline-connectivity/api/backend-api-client";
import type { CameraStatus } from "@/modules/offline-connectivity/api/telemetry-api-types";

export function CameraCard({ camera, id }: { camera?: CameraStatus; id: number }) {
  const [streamError, setStreamError] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [streamMode, setStreamMode] = useState<"raw" | "annotated">("raw");
  const [streamLoaded, setStreamLoaded] = useState(false);
  const mirror = id === 2 && camera?.testMirror;
  const url = streamMode === "raw" ? rawVideoUrl(id) : videoUrl(id);
  const cameraOnline = Boolean(camera?.displayOnline ?? camera?.online);
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

  useEffect(() => {
    if (!cameraOnline || streamError) return;
    const timer = window.setTimeout(() => {
      if (streamMode === "raw" && !streamLoaded) setStreamMode("annotated");
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [cameraOnline, streamError, streamLoaded, streamMode]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Camera {id === 1 ? "A" : "B"} / Lane {id === 1 ? "A" : "B"}
        </CardTitle>
        <CardDescription>
          {mirror ? "TEST ONLY: Camera A display mirror. No Node B detection or counts. " : ""}
          {streamMode === "raw" ? "Raw CCTV Â· unannotated" : "Annotated MJPEG fallback"}
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
              alt={`${streamMode === "raw" ? "Raw" : "Annotated fallback"} traffic feed for Camera ${id}`}
              onLoad={() => setStreamLoaded(true)}
              onError={() => {
                setStreamLoaded(false);
                if (streamMode === "raw") setStreamMode("annotated");
                else setStreamError(true);
              }}
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
