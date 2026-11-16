import { Timestamp } from "firebase-admin/firestore";

// Writes validated, completed traffic transactions and their vehicle events to Firestore.

import { adminDb } from "@/lib/firebase/admin";

import type { TrafficTransaction } from "./traffic-transaction-validation";

function asTimestamp(value: string | null) {
  return value ? Timestamp.fromDate(new Date(value)) : null;
}

function safeDocumentId(value: string) {
  return value.replaceAll("/", "_");
}

export async function persistTrafficTransaction(transaction: TrafficTransaction) {
  const transactionId = safeDocumentId(transaction.transactionId);
  let batch = adminDb.batch();
  let pendingEvents = 0;
  const releasedVehicles = transaction.releasedVehicles.map((vehicle) => ({
    ...vehicle,
    destinationConfirmedAt: asTimestamp(vehicle.destinationConfirmedAt),
    redTouchedAt: asTimestamp(vehicle.redTouchedAt),
    sourceDetectedAt: asTimestamp(vehicle.sourceDetectedAt),
    sourceReleasedAt: asTimestamp(vehicle.sourceReleasedAt),
  }));

  const writeTransaction = () =>
    batch.set(
      adminDb.collection("trafficTransactions").doc(transactionId),
      {
        ...transaction,
        completedAt: asTimestamp(transaction.completedAt),
        createdAt: asTimestamp(transaction.createdAt),
        greenStartedAt: asTimestamp(transaction.greenStartedAt),
        greenEndedAt: asTimestamp(transaction.greenEndedAt ?? null),
        releasedVehicles,
        schemaVersion: 2,
        source: "live-transaction",
        sourceCompletedAt: asTimestamp(transaction.sourceCompletedAt),
        storedAt: Timestamp.now(),
      },
      { merge: true },
    );

  // Preserve a single atomic write for normal batches. Larger timer batches
  // use idempotent event IDs and publish their parent only after all chunks.
  const largeBatch = releasedVehicles.length > 400;
  if (!largeBatch) writeTransaction();

  for (const vehicle of releasedVehicles) {
    const eventId = safeDocumentId(`${transaction.transactionId}_${vehicle.gid}`);
    const sourceIsNodeA = transaction.sourceNode === "node-a";
    batch.set(
      adminDb.collection("trafficEvents").doc(eventId),
      {
        cameraId: sourceIsNodeA ? 1 : 2,
        confidence: vehicle.sourceConfidence,
        destinationConfirmedAt: vehicle.destinationConfirmedAt,
        destinationNode: transaction.destinationNode,
        destinationTrackId: vehicle.destinationTrackId,
        direction: "forward",
        eventType: "vehicle_passed",
        laneId: sourceIsNodeA ? "lane-a" : "lane-b",
        nodeId: transaction.sourceNode,
        occurredAt: vehicle.sourceReleasedAt,
        points: vehicle.points,
        redTouchedAt: vehicle.redTouchedAt,
        schemaVersion: 2,
        sessionId: transaction.transactionId,
        source: "live-transaction",
        sourceDetectedAt: vehicle.sourceDetectedAt,
        sourceTrackId: vehicle.sourceTrackId,
        transactionId: transaction.transactionId,
        decisionMode: transaction.decisionMode,
        vehicleClass: vehicle.class,
        vehicleId: vehicle.gid,
      },
      { merge: true },
    );
    pendingEvents += 1;
    if (largeBatch && pendingEvents === 400) {
      await batch.commit();
      batch = adminDb.batch();
      pendingEvents = 0;
    }
  }

  if (largeBatch) writeTransaction();
  await batch.commit();
}
