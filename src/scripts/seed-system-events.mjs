import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const COLLECTION_NAME = "systemEvents";
const DEMO_SOURCE = "demo-system-seed";
const SEED_NAMESPACE = "system-events-demo-v1";
const BATCH_SIZE = 400;
const MINUTE_MS = 60 * 1000;
const seedReferenceDate = process.env.SYSTEM_SEED_REFERENCE_DATE
  ? new Date(process.env.SYSTEM_SEED_REFERENCE_DATE)
  : new Date();

if (Number.isNaN(seedReferenceDate.getTime())) {
  throw new Error("SYSTEM_SEED_REFERENCE_DATE must be a valid ISO date.");
}

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.GCLOUD_PROJECT;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
const missingConfig = [
  !projectId && "FIREBASE_ADMIN_PROJECT_ID",
  !clientEmail && "FIREBASE_ADMIN_CLIENT_EMAIL",
  !privateKey && "FIREBASE_ADMIN_PRIVATE_KEY",
].filter(Boolean);

if (missingConfig.length > 0) {
  throw new Error(`Missing Firebase Admin configuration: ${missingConfig.join(", ")}`);
}

const app =
  getApps()[0] ??
  initializeApp({
    projectId,
    credential: cert({ projectId, clientEmail, privateKey }),
  });
const db = getFirestore(app);

console.log(`Firebase project target: ${projectId}`);

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

const eventSpecs = [
  {
    minutesAgo: 4_180,
    eventType: "system_started",
    category: "system",
    component: "backend",
    severity: "info",
    message: "Traffic monitoring service started",
    eventStatus: "observed",
    nodeId: "system",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 4_176,
    eventType: "detector_ready",
    category: "detector",
    component: "YOLO detector",
    severity: "info",
    message: "Vehicle detector loaded and ready",
    eventStatus: "observed",
    nodeId: "system",
  },
  {
    minutesAgo: 4_170,
    eventType: "node_online",
    category: "network",
    component: "edge node",
    severity: "info",
    message: "Node A connected to the monitoring server",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 4_166,
    eventType: "node_online",
    category: "network",
    component: "edge node",
    severity: "info",
    message: "Node B connected to the monitoring server",
    eventStatus: "observed",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 3_020,
    eventType: "traffic_snapshot",
    category: "traffic",
    component: "camera 1",
    severity: "info",
    message: "Hourly traffic snapshot recorded",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    vehicleCount: 43,
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 2_720,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 2",
    severity: "critical",
    message: "Camera 2 stream became unreachable",
    eventStatus: "resolved",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "UNKNOWN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 2_706,
    eventType: "camera_reconnected",
    category: "camera",
    component: "camera 2",
    severity: "info",
    message: "Camera 2 stream restored after 14 minutes",
    eventStatus: "observed",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 2_010,
    eventType: "power_source_changed",
    category: "power",
    component: "power controller",
    severity: "warning",
    message: "Node A switched to battery backup",
    eventStatus: "resolved",
    nodeId: "node-a",
    laneId: "lane-a",
    batteryPercent: 78,
    powerSource: "Battery Backup",
  },
  {
    minutesAgo: 1_930,
    eventType: "power_restored",
    category: "power",
    component: "power controller",
    severity: "info",
    message: "AC power restored on Node A",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    batteryPercent: 70,
    powerSource: "AC Power",
  },
  {
    minutesAgo: 1_180,
    eventType: "signal_degraded",
    category: "signal",
    component: "traffic signal controller",
    severity: "warning",
    message: "Node B signal response exceeded threshold",
    eventStatus: "resolved",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "UNKNOWN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 1_164,
    eventType: "signal_restored",
    category: "signal",
    component: "traffic signal controller",
    severity: "info",
    message: "Node B signal communication returned to normal",
    eventStatus: "observed",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 840,
    eventType: "detector_unavailable",
    category: "detector",
    component: "YOLO detector",
    severity: "critical",
    message: "Vehicle detector stopped responding",
    eventStatus: "resolved",
    nodeId: "system",
  },
  {
    minutesAgo: 832,
    eventType: "detector_recovered",
    category: "detector",
    component: "YOLO detector",
    severity: "info",
    message: "Vehicle detector recovered after automatic restart",
    eventStatus: "observed",
    nodeId: "system",
  },
  {
    minutesAgo: 480,
    eventType: "traffic_snapshot",
    category: "traffic",
    component: "camera 1",
    severity: "info",
    message: "Morning traffic snapshot recorded",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    vehicleCount: 67,
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 360,
    eventType: "traffic_snapshot",
    category: "traffic",
    component: "camera 2",
    severity: "info",
    message: "Morning traffic snapshot recorded",
    eventStatus: "observed",
    nodeId: "node-b",
    laneId: "lane-b",
    vehicleCount: 52,
    signal: "GREEN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 190,
    eventType: "node_offline",
    category: "network",
    component: "edge node",
    severity: "critical",
    message: "Node B stopped sending heartbeat data",
    eventStatus: "resolved",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "UNKNOWN",
    powerSource: "Battery Backup",
    batteryPercent: 38,
  },
  {
    minutesAgo: 174,
    eventType: "node_reconnected",
    category: "network",
    component: "edge node",
    severity: "info",
    message: "Node B reconnected after 16 minutes offline",
    eventStatus: "observed",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "GREEN",
    powerSource: "Battery Backup",
    batteryPercent: 35,
  },
  {
    minutesAgo: 96,
    eventType: "low_power",
    category: "power",
    component: "battery controller",
    severity: "warning",
    message: "Node A battery level dropped below 25%",
    eventStatus: "active",
    nodeId: "node-a",
    laneId: "lane-a",
    signal: "GREEN",
    powerSource: "Battery Backup",
    batteryPercent: 23,
  },
  {
    minutesAgo: 42,
    eventType: "signal_degraded",
    category: "signal",
    component: "traffic signal controller",
    severity: "warning",
    message: "Intermittent signal detected on Node B",
    eventStatus: "active",
    nodeId: "node-b",
    laneId: "lane-b",
    signal: "UNKNOWN",
    powerSource: "AC Power",
  },
  {
    minutesAgo: 12,
    eventType: "traffic_snapshot",
    category: "traffic",
    component: "camera 1",
    severity: "info",
    message: "Latest traffic snapshot recorded",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    vehicleCount: 31,
    signal: "GREEN",
    powerSource: "Battery Backup",
    batteryPercent: 21,
  },
  // Demo-only hardware telemetry so every planned catalog state can be reviewed before hardware is connected.
  {
    minutesAgo: 20,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 1",
    severity: "warning",
    message: "USB camera 1 unavailable",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 19,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 1",
    severity: "warning",
    message: "Retry 1/3: USB camera 1 unavailable",
    eventStatus: "active",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 18,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 1",
    severity: "warning",
    message: "Retry 2/3: USB camera 1 unavailable",
    eventStatus: "active",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 17,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 1",
    severity: "warning",
    message: "Retry 3/3: USB camera 1 unavailable",
    eventStatus: "active",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 16,
    eventType: "camera_disconnected",
    category: "camera",
    component: "camera 1",
    severity: "critical",
    message: "USB camera 1 unavailable persists after retries",
    eventStatus: "active",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 15,
    eventType: "camera_health_restored",
    category: "camera",
    component: "camera 1",
    severity: "info",
    message: "Camera 1 feed restored",
    eventStatus: "resolved",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 11,
    eventType: "camera_stale",
    category: "camera",
    component: "camera 1",
    severity: "warning",
    message: "Camera 1 feed is stale",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 10,
    eventType: "detector_unavailable",
    category: "detector",
    component: "YOLO detector",
    severity: "warning",
    message: "Vehicle detector is retrying",
    eventStatus: "observed",
    nodeId: "system",
  },
  {
    minutesAgo: 9,
    eventType: "wifi_disconnected",
    category: "network",
    component: "Node Wi-Fi",
    severity: "warning",
    message: "Node B Wi-Fi disconnected; retrying connection",
    eventStatus: "active",
    nodeId: "node-b",
    laneId: "lane-b",
  },
  {
    minutesAgo: 8,
    eventType: "esp32_disconnected",
    category: "node",
    component: "ESP32",
    severity: "warning",
    message: "Node A is unreachable; retrying heartbeat",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 7,
    eventType: "traffic_controller_retrying",
    category: "traffic_control",
    component: "traffic signal controller",
    severity: "warning",
    message: "Traffic controller command is being retried",
    eventStatus: "active",
    nodeId: "system",
  },
  {
    minutesAgo: 6,
    eventType: "gps_unavailable",
    category: "gps",
    component: "GPS module",
    severity: "warning",
    message: "GPS position unavailable; waiting for a fix",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 5,
    eventType: "gps_stale",
    category: "gps",
    component: "GPS module",
    severity: "critical",
    message: "GPS position remains stale after retries",
    eventStatus: "active",
    nodeId: "node-b",
    laneId: "lane-b",
  },
  {
    minutesAgo: 4,
    eventType: "compass_drift",
    category: "compass",
    component: "Compass module",
    severity: "warning",
    message: "Node A compass angle drift detected",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 3,
    eventType: "node_compromised",
    category: "security",
    component: "Node orientation",
    severity: "critical",
    message: "Node B orientation changed; possible displacement",
    eventStatus: "active",
    nodeId: "node-b",
    laneId: "lane-b",
  },
  {
    minutesAgo: 2,
    eventType: "low_battery",
    category: "power",
    component: "battery controller",
    severity: "warning",
    message: "Node A battery level is low",
    eventStatus: "observed",
    nodeId: "node-a",
    laneId: "lane-a",
    batteryPercent: 18,
    powerSource: "Battery Backup",
  },
  {
    minutesAgo: 1,
    eventType: "battery_critical",
    category: "power",
    component: "battery controller",
    severity: "critical",
    message: "Node B battery level is critically low",
    eventStatus: "active",
    nodeId: "node-b",
    laneId: "lane-b",
    batteryPercent: 8,
    powerSource: "Battery Backup",
  },
  {
    minutesAgo: 0,
    eventType: "camera_health_restored",
    category: "camera",
    component: "camera 1",
    severity: "info",
    message: "Camera 1 feed restored",
    eventStatus: "resolved",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 0,
    eventType: "wifi_restored",
    category: "network",
    component: "Node Wi-Fi",
    severity: "info",
    message: "Node B Wi-Fi connection restored",
    eventStatus: "resolved",
    nodeId: "node-b",
    laneId: "lane-b",
  },
  {
    minutesAgo: 0,
    eventType: "gps_restored",
    category: "gps",
    component: "GPS module",
    severity: "info",
    message: "GPS position fix restored",
    eventStatus: "resolved",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 0,
    eventType: "compass_stable",
    category: "compass",
    component: "Compass module",
    severity: "info",
    message: "Node A compass angle returned to normal",
    eventStatus: "resolved",
    nodeId: "node-a",
    laneId: "lane-a",
  },
  {
    minutesAgo: 0,
    eventType: "node_recovered",
    category: "security",
    component: "Node orientation",
    severity: "info",
    message: "Node B displacement alert resolved after retrieval",
    eventStatus: "resolved",
    nodeId: "node-b",
    laneId: "lane-b",
  },
];

function createDemoEvents(now = new Date()) {
  return eventSpecs.map((event, index) => {
    const { minutesAgo, ...eventData } = event;

    return {
      id: `demo-system-v1-${String(index + 1).padStart(4, "0")}`,
      data: {
        ...eventData,
        occurredAt: Timestamp.fromDate(new Date(now.getTime() - minutesAgo * MINUTE_MS)),
        schemaVersion: 1,
        seedNamespace: SEED_NAMESPACE,
        sequence: index + 1,
        source: DEMO_SOURCE,
      },
    };
  });
}

async function assertSafeTargetIds(events) {
  const snapshots = await Promise.all(events.map((event) => db.collection(COLLECTION_NAME).doc(event.id).get()));
  const collisions = snapshots.filter((snapshot) => snapshot.exists && snapshot.data().seedNamespace !== SEED_NAMESPACE);

  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite non-demo documents: ${collisions.map((item) => item.id).join(", ")}`);
  }
}

async function deleteExistingDemoEvents() {
  const snapshot = await db.collection(COLLECTION_NAME).where("seedNamespace", "==", SEED_NAMESPACE).get();
  const unsafeDocuments = snapshot.docs.filter((document) => document.data().source !== DEMO_SOURCE);

  if (unsafeDocuments.length > 0) {
    throw new Error(
      `Refusing to delete documents with an unexpected source: ${unsafeDocuments.map((item) => item.id).join(", ")}`,
    );
  }

  for (const documents of chunk(snapshot.docs, BATCH_SIZE)) {
    const batch = db.batch();
    for (const document of documents) batch.delete(document.ref);
    await batch.commit();
  }

  return snapshot.size;
}

async function seedDemoEvents() {
  const events = createDemoEvents(seedReferenceDate);
  await assertSafeTargetIds(events);
  const removed = await deleteExistingDemoEvents();

  for (const eventChunk of chunk(events, BATCH_SIZE)) {
    const batch = db.batch();
    for (const event of eventChunk) batch.set(db.collection(COLLECTION_NAME).doc(event.id), event.data);
    await batch.commit();
  }

  const verification = await db.collection(COLLECTION_NAME).where("seedNamespace", "==", SEED_NAMESPACE).get();
  if (verification.size !== events.length) {
    throw new Error(`Expected ${events.length} demo events after seeding, found ${verification.size}.`);
  }

  console.log(`Seeded ${events.length} system events in ${COLLECTION_NAME}; replaced ${removed} previous demo events.`);
}

try {
  if (process.argv.includes("--delete")) {
    const removed = await deleteExistingDemoEvents();
    console.log(`Deleted ${removed} demo system events from ${COLLECTION_NAME}.`);
  } else {
    await seedDemoEvents();
  }
} finally {
  await app.delete();
}
