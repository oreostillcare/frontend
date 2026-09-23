import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";

const nodeSchema = z.enum(["node-a", "node-b"]);
const timestampSchema = z.string().datetime({ offset: true });
const optionalTimestampSchema = timestampSchema.nullable();

const releasedVehicleSchema = z.object({
  class: z.string().min(1),
  destination: nodeSchema,
  destinationConfidence: z.number().min(0).max(1).nullable(),
  destinationConfirmedAt: timestampSchema,
  destinationTrackId: z.number().int().nullable(),
  gid: z.string().min(1),
  points: z.number().int().min(0),
  redTouchedAt: timestampSchema,
  source: nodeSchema,
  sourceConfidence: z.number().min(0).max(1).nullable(),
  sourceDetectedAt: optionalTimestampSchema,
  sourceReleasedAt: timestampSchema,
  sourceTrackId: z.number().int().nullable(),
  transactionId: z.string().min(1),
});

const trafficTransactionSchema = z
  .object({
    batchPoints: z.number().int().min(0),
    batchTotal: z.number().int().positive().max(400),
    completedAt: timestampSchema,
    createdAt: timestampSchema,
    destinationKey: z.enum(["nodeA", "nodeB"]),
    destinationNode: nodeSchema,
    destinationRemaining: z.literal(0),
    greenStartedAt: timestampSchema,
    releasedVehicles: z.array(releasedVehicleSchema),
    sourceCompletedAt: timestampSchema,
    sourceKey: z.enum(["nodeA", "nodeB"]),
    sourceNode: nodeSchema,
    sourceRemaining: z.literal(0),
    status: z.literal("complete"),
    transactionId: z.string().min(1),
  })
  .superRefine((transaction, context) => {
    if (transaction.releasedVehicles.length !== transaction.batchTotal) {
      context.addIssue({
        code: "custom",
        message: "releasedVehicles must contain exactly batchTotal vehicles.",
        path: ["releasedVehicles"],
      });
    }
    if (transaction.sourceNode === transaction.destinationNode) {
      context.addIssue({
        code: "custom",
        message: "Source and destination nodes must be different.",
        path: ["destinationNode"],
      });
    }
    const uniqueGids = new Set(transaction.releasedVehicles.map((vehicle) => vehicle.gid));
    if (uniqueGids.size !== transaction.batchTotal) {
      context.addIssue({
        code: "custom",
        message: "Each GID must occur only once in a transaction.",
        path: ["releasedVehicles"],
      });
    }
    const inconsistentVehicle = transaction.releasedVehicles.some(
      (vehicle) =>
        vehicle.transactionId !== transaction.transactionId ||
        vehicle.source !== transaction.sourceNode ||
        vehicle.destination !== transaction.destinationNode,
    );
    if (inconsistentVehicle) {
      context.addIssue({
        code: "custom",
        message: "Vehicle transaction and node fields must match the parent transaction.",
        path: ["releasedVehicles"],
      });
    }
  });

function asTimestamp(value: string | null) {
  return value ? Timestamp.fromDate(new Date(value)) : null;
}

function safeDocumentId(value: string) {
  return value.replaceAll("/", "_");
}

export async function POST(request: Request) {
  const ingestSecret = process.env.TRAFFIC_INGEST_SECRET || process.env.CRON_SECRET;
  if (!ingestSecret) {
    return Response.json({ success: false, message: "Traffic ingest secret is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${ingestSecret}`) {
    return Response.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = trafficTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { success: false, message: "Invalid traffic transaction.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const transaction = parsed.data;
  const transactionId = safeDocumentId(transaction.transactionId);

  try {
    const batch = adminDb.batch();
    const releasedVehicles = transaction.releasedVehicles.map((vehicle) => ({
      ...vehicle,
      destinationConfirmedAt: asTimestamp(vehicle.destinationConfirmedAt),
      redTouchedAt: asTimestamp(vehicle.redTouchedAt),
      sourceDetectedAt: asTimestamp(vehicle.sourceDetectedAt),
      sourceReleasedAt: asTimestamp(vehicle.sourceReleasedAt),
    }));

    batch.set(
      adminDb.collection("trafficTransactions").doc(transactionId),
      {
        ...transaction,
        completedAt: asTimestamp(transaction.completedAt),
        createdAt: asTimestamp(transaction.createdAt),
        greenStartedAt: asTimestamp(transaction.greenStartedAt),
        releasedVehicles,
        schemaVersion: 1,
        source: "live-transaction",
        sourceCompletedAt: asTimestamp(transaction.sourceCompletedAt),
        storedAt: Timestamp.now(),
      },
      { merge: true },
    );

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
          vehicleClass: vehicle.class,
          vehicleId: vehicle.gid,
        },
        { merge: true },
      );
    }

    await batch.commit();
    return Response.json({
      success: true,
      transactionId: transaction.transactionId,
      vehicleCount: transaction.batchTotal,
    });
  } catch (error) {
    console.error("Traffic transaction persistence failed:", error);
    return Response.json({ success: false, message: "Firestore transaction write failed." }, { status: 500 });
  }
}
