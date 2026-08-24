export type TrafficSignal = "RED" | "GREEN" | "UNKNOWN";
export interface VehicleClassCounts {
  car?: number;
  motorcycle?: number;
  truck?: number;
  bus?: number;
  ebike?: number;
  etrike?: number;
  jeepney?: number;
}
export interface CameraStatus {
  id: number;
  configured: boolean;
  online: boolean;
  testMirror?: boolean;
  sourceCamera?: number;
  captureFps?: number | null;
  fps?: number | null;
  processingMs?: number | null;
  frameAgeMs?: number | null;
  tracker?: string;
  modelOnline?: boolean;
  visibleVehicles?: number;
  vehiclesPassed?: number;
  classes?: VehicleClassCounts;
}
export interface TrafficNode {
  signal: TrafficSignal;
  remainingSeconds?: number;
  durationSeconds?: number;
  mode?: string;
  visibleVehicles?: number;
  vehiclesPassed?: number;
}
export interface SystemStatus {
  status: "online" | "offline" | "initializing";
  powerSource?: "AC Power" | "Battery Backup" | "Unknown";
  batteryPercent?: number;
  charging?: boolean;
  yoloOnline?: boolean;
  cameras?: CameraStatus[];
  nodeA?: TrafficNode;
  nodeB?: TrafficNode;
}
export interface ModelStatus {
  model: "custom" | "coco" | "unavailable";
  weights?: string;
  online?: boolean;
}
export interface SystemLog {
  id: string;
  timestamp: string;
  event: string;
  lane?: string;
  vehicleCount?: number;
  signal?: TrafficSignal;
  powerSource?: string;
  status?: string;
}
export interface AnalyticsPoint {
  timestamp: string;
  laneA: number;
  laneB: number;
}
