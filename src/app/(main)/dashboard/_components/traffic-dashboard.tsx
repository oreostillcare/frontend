"use client";

import { BatteryCharging, Camera, Cpu, Power, RadioTower } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTelemetry } from "@/hooks/use-telemetry";
import type { CameraStatus, TrafficNode } from "@/lib/api/types";

const classes = ["car", "motorcycle", "truck", "bus", "ebike", "etrike", "jeepney"] as const;
const value = (input: number | string | undefined) => input ?? "--";

function StatusCard({
  title,
  value: display,
  icon: Icon,
  note,
}: {
  title: string;
  value: string;
  icon: typeof Power;
  note?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle>{display}</CardTitle>
        <CardAction>
          <Icon className="text-muted-foreground" />
        </CardAction>
      </CardHeader>
      {note && <CardContent className="text-xs text-muted-foreground">{note}</CardContent>}
    </Card>
  );
}

function NodeCard({
  name,
  lane,
  node,
  camera,
}: {
  name: string;
  lane: string;
  node?: TrafficNode;
  camera?: CameraStatus;
}) {
  const signal = node?.signal ?? "UNKNOWN";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {name} / {lane}
        </CardTitle>
        <CardDescription>Local controller telemetry</CardDescription>
        <CardAction>
          <Badge variant={signal === "RED" ? "destructive" : signal === "GREEN" ? "secondary" : "outline"}>
            {signal}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Remaining</p>
            <p className="font-heading text-2xl">
              {node?.remainingSeconds === undefined ? "--" : `${node.remainingSeconds}s`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Visible</p>
            <p className="font-heading text-2xl">{value(camera?.visibleVehicles)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Passed</p>
            <p className="font-heading text-2xl">{value(camera?.vehiclesPassed)}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {classes.map((item) => (
            <div className="rounded-lg bg-muted/50 px-3 py-2" key={item}>
              <span className="capitalize text-muted-foreground">{item}</span>
              <span className="float-right font-medium">{value(camera?.classes?.[item])}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Mode: {value(node?.mode)} · Camera:{" "}
          {camera?.online ? "Online" : camera?.configured ? "Offline" : "Not available"}
        </p>
      </CardContent>
    </Card>
  );
}

export function TrafficDashboard() {
  const { system, cameras, loading, error } = useTelemetry();
  if (loading)
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton className="h-28" key={index} />
        ))}
      </div>
    );
  const cameraA = cameras[0];
  const cameraB = cameras[1]?.testMirror ? undefined : cameras[1];
  const physicalCameras = cameras.filter((camera) => !camera.testMirror);
  const expectedCameraCount = Math.max(physicalCameras.length, 1);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-3xl leading-none tracking-tight">Traffic Management Overview</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Monitoring only — signal control remains on the local roadside controller.
        </p>
      </div>
      {error && <Badge variant="destructive">Detection backend offline</Badge>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatusCard title="System Status" value={system?.status ?? "Offline"} icon={RadioTower} />
        <StatusCard title="Power Source" value={system?.powerSource ?? "Unknown"} icon={Power} />
        <StatusCard
          title="Battery"
          value={system?.batteryPercent === undefined ? "--" : `${system.batteryPercent}%`}
          icon={BatteryCharging}
          note={system?.charging === undefined ? "Charging: --" : `Charging: ${system.charging ? "Yes" : "No"}`}
        />
        <StatusCard title="Detection Service" value={system?.yoloOnline ? "YOLO Online" : "YOLO Offline"} icon={Cpu} />
        <StatusCard
          title="Cameras"
          value={`${physicalCameras.filter((item) => item.online).length} / ${expectedCameraCount} online`}
          icon={Camera}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <NodeCard name="Node A" lane="Lane A" node={system?.nodeA} camera={cameraA} />
        <NodeCard name="Node B" lane="Lane B" node={system?.nodeB} camera={cameraB} />
      </div>
    </div>
  );
}
