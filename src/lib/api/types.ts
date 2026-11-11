export type TrafficSignal = "RED" | "GREEN" | "YELLOW" | "UNKNOWN";
export interface VehicleClassCounts {
  car?: number;
  motorcycle?: number;
  truck?: number;
  bus?: number;
  bicycle?: number;
  ebike?: number;
  jeepney?: number;
  tricycle?: number;
}
export interface IncomingVehicleRecord {
  gid: string;
  trackId?: number | null;
  class: string;
  confidence?: number | null;
  detectedAt: string;
  points: number;
}
export interface CameraStatus {
  id: number;
  nodeId?: "node-a" | "node-b";
  laneId?: "lane-a" | "lane-b";
  configured: boolean;
  online: boolean;
  testMirror?: boolean;
  displayOnline?: boolean;
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
  incomingVehicles?: IncomingVehicleRecord[];
  incomingPoints?: number | null;
  totalVehicles?: number | null;
  expectedVehicles?: number | null;
  vehicleCountState?: "CALCULATING" | "LOCKED BATCH" | "TIMER BATCH" | "EXPECTING" | "OFFLINE";
}
export interface TrafficNode {
  signal: TrafficSignal;
  cameraId?: number;
  nodeId?: "node-a" | "node-b";
  laneId?: "lane-a" | "lane-b";
  online?: boolean;
  remainingSeconds?: number;
  durationSeconds?: number;
  mode?: string;
  status?: string;
  visibleVehicles?: number;
  vehiclesPassed?: number;
  classes?: VehicleClassCounts;
  incomingVehicles?: IncomingVehicleRecord[];
  incomingPoints?: number | null;
  totalVehicles?: number | null;
  expectedVehicles?: number | null;
  vehicleCountState?: "CALCULATING" | "LOCKED BATCH" | "TIMER BATCH" | "EXPECTING" | "OFFLINE";
}
export interface TrafficControlNode {
  points: number;
  ready: boolean;
  signal: TrafficSignal;
}
export interface TrafficControlStatus {
  enabled: boolean;
  mode: "TRANSACTION_BATCH" | "POINT_PRIORITY" | "DISABLED";
  decision: "nodeA" | "nodeB" | "nodeAYellow" | "nodeBYellow" | "allRed" | null;
  commandedState: string;
  reason: string;
  nodeA: TrafficControlNode;
  nodeB: TrafficControlNode;
  transaction: TrafficTransaction | null;
  lastCompletedTransaction: TrafficTransaction | null;
  firestoreUploadEnabled: boolean;
  lastError: string | null;
}
export interface Esp32NodeStatus {
  online: boolean;
  powerOn: boolean;
  wifiConnected: boolean;
  ssid: string | null;
  lastSeen: string | null;
}
export interface Esp32Status {
  timeoutSeconds: number;
  nodeA: Esp32NodeStatus;
  nodeB: Esp32NodeStatus;
}
export interface ReleasedVehicleRecord {
  gid: string;
  class: string;
  points: number;
  source: "node-a" | "node-b";
  destination: "node-a" | "node-b";
  sourceTrackId: number | null;
  sourceConfidence: number | null;
  sourceDetectedAt: string | null;
  redTouchedAt: string | null;
  sourceReleasedAt: string;
  destinationTrackId: number | null;
  destinationConfidence: number | null;
  destinationConfirmedAt: string | null;
  transactionId: string;
}
export interface TrafficTransaction {
  decisionMode?: "WEIGHTED" | "TIMER";
  enteredCount?: number;
  exitedCount?: number;
  timerDurationSeconds?: number;
  timerRemainingSeconds?: number;
  unusedGreenSeconds?: number;
  greenEndedAt?: string;
  endReason?: "timer_expired" | "incoming_inactivity" | "weighted_batch_released";
  anomaly?: string;
  transactionId: string;
  sourceKey: "nodeA" | "nodeB";
  destinationKey: "nodeA" | "nodeB";
  sourceNode: "node-a" | "node-b";
  destinationNode: "node-a" | "node-b";
  batchTotal: number;
  batchPoints: number;
  sourceRemaining: number;
  destinationRemaining: number;
  releasedVehicles: ReleasedVehicleRecord[];
  status:
    | "pending_green"
    | "active"
    | "source_complete"
    | "yellow_pending"
    | "yellow"
    | "clearance"
    | "anomaly"
    | "persist_pending"
    | "complete";
  createdAt: string;
  greenStartedAt: string | null;
  sourceCompletedAt: string | null;
  completedAt: string | null;
  persistedAt?: string | null;
  firestoreUploaded?: boolean;
}
export interface SystemStatus {
  status: "online" | "offline" | "initializing";
  powerSource?: "AC Power" | "Battery Backup" | "Unknown";
  batteryPercent?: number;
  charging?: boolean;
  yoloOnline?: boolean;
  cameraStatus?: {
    online: number;
    total: number;
  };
  cameras?: CameraStatus[];
  nodeA?: TrafficNode;
  nodeB?: TrafficNode;
  esp32Status?: Esp32Status;
  trafficControl?: TrafficControlStatus;
}
export interface ModelStatus {
  model: "dual" | "custom" | "coco" | "unavailable";
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
