import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  terminate,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";

const COLLECTION_NAME = "systemEvents";
const DEMO_SOURCE = "demo-system-seed";
const SEED_NAMESPACE = "system-events-demo-v1";
const BATCH_SIZE = 400;
const MINUTE_MS = 60 * 1000;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const requiredConfig = ["apiKey", "authDomain", "projectId", "appId"];
const missingConfig = requiredConfig.filter((key) => !firebaseConfig[key]);

if (missingConfig.length > 0) {
  throw new Error(`Missing Firebase configuration: ${missingConfig.join(", ")}`);
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

console.log(`Firebase project target: ${firebaseConfig.projectId}`);

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
  const snapshots = await Promise.all(events.map((event) => getDoc(doc(db, COLLECTION_NAME, event.id))));
  const collisions = snapshots.filter(
    (snapshot) => snapshot.exists() && snapshot.data().seedNamespace !== SEED_NAMESPACE,
  );

  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite non-demo documents: ${collisions.map((item) => item.id).join(", ")}`);
  }
}

async function deleteExistingDemoEvents() {
  const snapshot = await getDocs(query(collection(db, COLLECTION_NAME), where("seedNamespace", "==", SEED_NAMESPACE)));
  const unsafeDocuments = snapshot.docs.filter((document) => document.data().source !== DEMO_SOURCE);

  if (unsafeDocuments.length > 0) {
    throw new Error(
      `Refusing to delete documents with an unexpected source: ${unsafeDocuments.map((item) => item.id).join(", ")}`,
    );
  }

  for (const documents of chunk(snapshot.docs, BATCH_SIZE)) {
    const batch = writeBatch(db);
    for (const document of documents) batch.delete(document.ref);
    await batch.commit();
  }

  return snapshot.size;
}

async function seedDemoEvents() {
  const events = createDemoEvents();
  await assertSafeTargetIds(events);
  const removed = await deleteExistingDemoEvents();

  for (const eventChunk of chunk(events, BATCH_SIZE)) {
    const batch = writeBatch(db);
    for (const event of eventChunk) batch.set(doc(db, COLLECTION_NAME, event.id), event.data);
    await batch.commit();
  }

  const verification = await getDocs(
    query(collection(db, COLLECTION_NAME), where("seedNamespace", "==", SEED_NAMESPACE)),
  );
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
  await terminate(db);
}
