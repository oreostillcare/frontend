import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const COLLECTION_NAME = "nodeSessionLogs";
const DEMO_SOURCE = "demo-node-session-seed";
const BATCH_SIZE = 400;

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.GCLOUD_PROJECT;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
const missingConfig = [
  !projectId && "FIREBASE_ADMIN_PROJECT_ID",
  !clientEmail && "FIREBASE_ADMIN_CLIENT_EMAIL",
  !privateKey && "FIREBASE_ADMIN_PRIVATE_KEY",
].filter(Boolean);

if (missingConfig.length > 0) {
  throw new Error(`Missing Firebase configuration: ${missingConfig.join(", ")}`);
}

const app =
  getApps()[0] ||
  initializeApp({
    projectId,
    credential: cert({ projectId, clientEmail, privateKey }),
  });
const db = getFirestore(app);

const originLocations = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94098, 121.16204)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94188, 121.16442)",
};

const retrievedLocations = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94112, 121.16230)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94190, 121.16430)",
};

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

async function deleteExistingDemoLogs() {
  const snapshot = await db.collection(COLLECTION_NAME).where("source", "==", DEMO_SOURCE).get();

  for (const documents of chunk(snapshot.docs, BATCH_SIZE)) {
    const batch = db.batch();
    for (const document of documents) batch.delete(document.ref);
    await batch.commit();
  }

  return snapshot.size;
}

function createDemoLogs() {
  const specs = [
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node A",
      occurredAt: "2026-11-01T08:15:00+08:00",
      sessionId: "demo-session-nov-01",
      status: "Active",
    },
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node B",
      occurredAt: "2026-11-01T08:20:00+08:00",
      sessionId: "demo-session-nov-01",
      status: "Active",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node A",
      occurredAt: "2026-11-01T12:15:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-nov-01",
      status: "Completed",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node B",
      occurredAt: "2026-11-01T12:20:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-nov-01",
      status: "Completed",
    },
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node A",
      occurredAt: "2026-11-02T07:45:00+08:00",
      sessionId: "demo-session-nov-02",
      status: "Active",
    },
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node B",
      occurredAt: "2026-11-02T07:50:00+08:00",
      sessionId: "demo-session-nov-02",
      status: "Active",
    },
    {
      actor: "Warning system",
      event: "Compromised",
      node: "Node A",
      occurredAt: "2026-11-02T13:10:00+08:00",
      sessionId: "demo-session-nov-02",
      status: "Compromised",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node A",
      occurredAt: "2026-11-02T15:30:00+08:00",
      sessionId: "demo-session-nov-02",
      status: "Completed",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node B",
      occurredAt: "2026-11-02T16:00:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-nov-02",
      status: "Completed",
    },
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node A",
      occurredAt: "2026-11-11T08:15:00+08:00",
      sessionId: "demo-session-nov-11",
      status: "Active",
    },
    {
      actor: "Administrator",
      event: "Origin position confirmed",
      node: "Node B",
      occurredAt: "2026-11-11T08:20:00+08:00",
      sessionId: "demo-session-nov-11",
      status: "Active",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node A",
      occurredAt: "2026-11-11T12:15:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-nov-11",
      status: "Completed",
    },
    {
      actor: "Administrator",
      event: "Retrieved",
      node: "Node B",
      occurredAt: "2026-11-11T12:20:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-nov-11",
      status: "Completed",
    },
  ];

  const additionalSessions = [
    {
      compromisedAt: "2026-11-03T11:30:00+08:00",
      incidentNode: "Node B",
      originA: "2026-11-03T08:00:00+08:00",
      originB: "2026-11-03T08:05:00+08:00",
      retrievedAt: "2026-11-03T13:00:00+08:00",
      retrievedAtOrigin: false,
      sessionId: "demo-session-node-b-nov-03",
    },
    {
      compromisedAt: "2026-11-04T10:15:00+08:00",
      incidentNode: "Node A",
      originA: "2026-11-04T07:45:00+08:00",
      originB: "2026-11-04T07:50:00+08:00",
      retrievedAt: "2026-11-04T12:00:00+08:00",
      retrievedAtOrigin: false,
      sessionId: "demo-session-node-a-nov-04",
    },
    {
      compromisedAt: null,
      incidentNode: "Node B",
      originA: "2026-11-05T08:10:00+08:00",
      originB: "2026-11-05T08:15:00+08:00",
      retrievedAt: "2026-11-05T12:30:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-node-b-nov-05",
    },
    {
      compromisedAt: null,
      incidentNode: "Node A",
      originA: "2026-11-06T07:30:00+08:00",
      originB: "2026-11-06T07:35:00+08:00",
      retrievedAt: "2026-11-06T11:45:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-node-a-nov-06",
    },
    {
      compromisedAt: null,
      incidentNode: "Node A",
      originA: "2026-11-07T07:00:00+08:00",
      originB: "2026-11-07T07:05:00+08:00",
      retrievedAt: "2026-11-07T10:50:00+08:00",
      otherRetrievedAt: "2026-11-07T11:00:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-node-a-nov-07-morning",
    },
    {
      compromisedAt: null,
      incidentNode: "Node A",
      originA: "2026-11-07T14:00:00+08:00",
      originB: "2026-11-07T14:05:00+08:00",
      retrievedAt: "2026-11-07T18:50:00+08:00",
      otherRetrievedAt: "2026-11-07T19:00:00+08:00",
      retrievedAtOrigin: true,
      sessionId: "demo-session-node-a-nov-07-afternoon",
    },
  ];

  for (const session of additionalSessions) {
    specs.push(
      {
        actor: "Administrator",
        event: "Origin position confirmed",
        node: "Node A",
        occurredAt: session.originA,
        sessionId: session.sessionId,
        status: "Active",
      },
      {
        actor: "Administrator",
        event: "Origin position confirmed",
        node: "Node B",
        occurredAt: session.originB,
        sessionId: session.sessionId,
        status: "Active",
      },
    );

    if (session.compromisedAt) {
      specs.push({
        actor: "Warning system",
        event: "Compromised",
        node: session.incidentNode,
        occurredAt: session.compromisedAt,
        sessionId: session.sessionId,
        status: "Compromised",
      });
    }

    specs.push({
      actor: "Administrator",
      event: "Retrieved",
      node: session.incidentNode,
      occurredAt: session.retrievedAt,
      retrievedAtOrigin: session.retrievedAtOrigin,
      sessionId: session.sessionId,
      status: "Completed",
    });

    const otherNode = session.incidentNode === "Node A" ? "Node B" : "Node A";
    const otherRetrievedAt =
      session.otherRetrievedAt ?? new Date(new Date(session.retrievedAt).getTime() + 30 * 60 * 1000).toISOString();
    specs.push({
      actor: "Administrator",
      event: "Retrieved",
      node: otherNode,
      occurredAt: otherRetrievedAt,
      retrievedAtOrigin: true,
      sessionId: session.sessionId,
      status: "Completed",
    });
  }

  const retrievedNodesBySession = new Map();
  for (const spec of specs) {
    if (spec.event !== "Retrieved") continue;
    const nodes = retrievedNodesBySession.get(spec.sessionId) || new Set();
    nodes.add(spec.node);
    retrievedNodesBySession.set(spec.sessionId, nodes);
  }

  return specs.map((spec, index) => {
    const occurredAt = new Date(spec.occurredAt);
    const retrievedLocation = spec.event === "Retrieved"
      ? spec.retrievedAtOrigin
        ? originLocations[spec.node]
        : retrievedLocations[spec.node]
      : null;

    return {
      id: `demo-node-session-${String(index + 1).padStart(4, "0")}`,
      data: {
        actor: spec.actor,
        event: spec.event,
        node: spec.node,
        originLocation: originLocations[spec.node],
        retrievedLocation,
        sessionComplete: retrievedNodesBySession.get(spec.sessionId)?.size === 2,
        occurredAt: Timestamp.fromDate(occurredAt),
        schemaVersion: 1,
        sessionId: spec.sessionId,
        source: DEMO_SOURCE,
        status: spec.status,
      },
    };
  });
}

const removed = await deleteExistingDemoLogs();
const logs = createDemoLogs();

for (const logChunk of chunk(logs, BATCH_SIZE)) {
  const batch = db.batch();
  for (const log of logChunk) batch.set(db.collection(COLLECTION_NAME).doc(log.id), log.data);
  await batch.commit();
}

console.log(`Seeded ${logs.length} node session logs in ${COLLECTION_NAME}; replaced ${removed} demo logs.`);
