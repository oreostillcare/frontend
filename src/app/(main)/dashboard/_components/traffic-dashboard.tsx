"use client";

import { BatteryCharging, Camera, Cpu, Power, RadioTower } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTelemetry } from "@/hooks/use-telemetry";
import type { CameraStatus, Esp32NodeStatus, TrafficNode } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const classes = ["car", "motorcycle", "truck", "bus", "bicycle", "ebike", "jeepney", "tricycle"] as const;
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

function StateBadge({
  active,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <Badge variant={active ? "outline" : "destructive"} className={cn(active && "text-black")}>
      {active ? activeLabel : inactiveLabel}
    </Badge>
  );
}

function formatLastSeen(timestamp: string | null) {
  if (!timestamp) return "Never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.toISOString().slice(11, 19)} UTC`;
}

function Esp32NodeSummary({ node }: { node: Esp32NodeStatus }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">ESP32 Status</p>
        <StateBadge active={node.online} activeLabel="Online" inactiveLabel="Offline" />
      </div>
      <div className="flex flex-wrap gap-1">
        <StateBadge active={node.powerOn} activeLabel="Power ON" inactiveLabel="Power OFF" />
        <StateBadge active={node.wifiConnected} activeLabel="Wi-Fi Connected" inactiveLabel="Wi-Fi Disconnected" />
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-2 text-xs">
        <dt className="text-muted-foreground">SSID</dt>
        <dd className="truncate" title={node.ssid ?? "Not available"}>
          {node.ssid ?? "Not available"}
        </dd>
        <dt className="text-muted-foreground">Last Seen</dt>
        <dd>{formatLastSeen(node.lastSeen)}</dd>
      </dl>
    </div>
  );
}

const offlineEsp32Node: Esp32NodeStatus = {
  online: false,
  powerOn: false,
  wifiConnected: false,
  ssid: null,
  lastSeen: null,
};

function NodeCard({
  name,
  lane,
  node,
  camera,
  esp32,
}: {
  name: string;
  lane: string;
  node?: TrafficNode;
  camera?: CameraStatus;
  esp32?: Esp32NodeStatus;
}) {
  const signal = node?.signal ?? "UNKNOWN";
  const cameraOnline = node?.online ?? camera?.online;
  const classCounts = node?.classes ?? camera?.classes;
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
        <div className="col-span-full pt-2">
          <Esp32NodeSummary node={esp32 ?? offlineEsp32Node} />
        </div>
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
            <p className="font-heading text-2xl">{value(node?.visibleVehicles ?? camera?.visibleVehicles)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Passed</p>
            <p className="font-heading text-2xl">{value(node?.vehiclesPassed ?? camera?.vehiclesPassed)}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {classes.map((item) => (
            <div className="rounded-lg bg-muted/50 px-3 py-2" key={item}>
              <span className="capitalize text-muted-foreground">{item}</span>
              <span className="float-right font-medium">{value(classCounts?.[item])}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Mode: {value(node?.mode ?? node?.status)} · Camera:{" "}
          {cameraOnline === true
            ? "Online"
            : cameraOnline === false || camera?.configured
              ? "Offline"
              : "Not available"}
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
  const cameraA = cameras.find((camera) => camera.id === 1 && (!camera.nodeId || camera.nodeId === "node-a"));
  const cameraB = cameras.find((camera) => camera.id === 2 && (!camera.nodeId || camera.nodeId === "node-b"));
  const onlineCameras = system?.cameraStatus?.online;
  const totalCameras = system?.cameraStatus?.total;
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
        <StatusCard title="Cameras" value={`${onlineCameras ?? "--"}/${totalCameras ?? "--"} online`} icon={Camera} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <NodeCard
          name="Node A"
          lane="Lane A"
          node={system?.nodeA}
          camera={cameraA}
          esp32={system?.esp32Status?.nodeA}
        />
        <NodeCard
          name="Node B"
          lane="Lane B"
          node={system?.nodeB}
          camera={cameraB}
          esp32={system?.esp32Status?.nodeB}
        />
      </div>
    </div>
  );
}
