import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  terminate,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";

const COLLECTION_NAME = "trafficEvents";
const DEMO_SOURCE = "demo-seed";
const BATCH_SIZE = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MANILA_OFFSET_MS = 8 * HOUR_MS;

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

const vehicleClasses = [
  "car",
  "motorcycle",
  "jeepney",
  "car",
  "tricycle",
  "sedan",
  "motorcycle",
  "bus",
  "suv",
  "car",
  "etrike",
  "truck",
  "jeepney",
  "ebike",
  "pickup",
  "van",
];

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

async function deleteExistingDemoEvents() {
  const snapshot = await getDocs(query(collection(db, COLLECTION_NAME), where("source", "==", DEMO_SOURCE)));

  for (const documents of chunk(snapshot.docs, BATCH_SIZE)) {
    const batch = writeBatch(db);
    for (const document of documents) batch.delete(document.ref);
    await batch.commit();
  }

  return snapshot.size;
}

function trafficCount(hour, dayOffset) {
  const dayVariation = (6 - dayOffset) % 3;
  if (hour >= 7 && hour <= 9) return 4 + dayVariation;
  if (hour >= 16 && hour <= 19) return 5 + dayVariation;
  if (hour >= 10 && hour <= 15) return 2 + (dayVariation % 2);
  return 1 + (dayVariation % 2);
}

function createDemoEvents(now = new Date()) {
  const currentTime = now.getTime();
  const todayStart = Math.floor((currentTime + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
  const events = [];
  let sequence = 0;

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const dayStart = todayStart - dayOffset * DAY_MS;

    for (let hour = 5; hour <= 22; hour += 1) {
      const count = trafficCount(hour, dayOffset);

      for (let occurrence = 0; occurrence < count; occurrence += 1) {
        const minute = Math.round(((occurrence + 1) * 60) / (count + 1)) + ((sequence * 7) % 5);
        const occurredAt = new Date(dayStart + hour * HOUR_MS + Math.min(minute, 59) * MINUTE_MS);
        if (occurredAt.getTime() > currentTime) continue;

        const nodeId = (sequence * 7 + dayOffset) % 10 < 6 ? "node-a" : "node-b";
        const cameraId = nodeId === "node-a" ? 1 : 2;
        const vehicleClass = vehicleClasses[(sequence * 5 + dayOffset * 3) % vehicleClasses.length];

        events.push({
          id: `demo-${String(sequence + 1).padStart(4, "0")}`,
          data: {
            cameraId,
            confidence: Math.min(0.98, 0.72 + ((sequence * 17) % 26) / 100),
            direction: sequence % 4 === 0 ? "reverse" : "forward",
            eventType: "vehicle_passed",
            laneId: nodeId === "node-a" ? "lane-a" : "lane-b",
            nodeId,
            occurredAt: Timestamp.fromDate(occurredAt),
            schemaVersion: 1,
            sessionId: "dashboard-demo",
            source: DEMO_SOURCE,
            trackId: 10_000 + sequence,
            vehicleClass,
            vehicleId: `DEMO-${String(sequence + 1).padStart(4, "0")}`,
          },
        });
        sequence += 1;
      }
    }
  }

  return events;
}

async function seedDemoEvents() {
  const removed = await deleteExistingDemoEvents();
  const events = createDemoEvents();

  for (const eventChunk of chunk(events, BATCH_SIZE)) {
    const batch = writeBatch(db);
    for (const event of eventChunk) batch.set(doc(db, COLLECTION_NAME, event.id), event.data);
    await batch.commit();
  }

  console.log(
    `Seeded ${events.length} traffic events in ${COLLECTION_NAME}; replaced ${removed} previous demo events.`,
  );
}

try {
  if (process.argv.includes("--delete")) {
    const removed = await deleteExistingDemoEvents();
    console.log(`Deleted ${removed} demo traffic events from ${COLLECTION_NAME}.`);
  } else {
    await seedDemoEvents();
  }
} finally {
  await terminate(db);
}
