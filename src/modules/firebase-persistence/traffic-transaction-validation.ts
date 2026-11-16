import { z } from "zod";

// Defines the trusted payload shape accepted by the traffic persistence API.

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

export const trafficTransactionSchema = z
  .object({
    batchPoints: z.number().int().min(0),
    batchTotal: z.number().int().nonnegative(),
    decisionMode: z.enum(["WEIGHTED", "TIMER"]).default("WEIGHTED"),
    enteredCount: z.number().int().nonnegative().optional(),
    exitedCount: z.number().int().nonnegative().optional(),
    timerDurationSeconds: z.literal(60).optional(),
    greenEndedAt: timestampSchema.optional(),
    unusedGreenSeconds: z.number().int().min(0).max(60).optional(),
    endReason: z.enum(["timer_expired", "incoming_inactivity", "weighted_batch_released"]).optional(),
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
    if (
      transaction.decisionMode === "TIMER" &&
      (transaction.enteredCount === undefined ||
        transaction.exitedCount === undefined ||
        transaction.timerDurationSeconds !== 60 ||
        transaction.greenEndedAt === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Timer batches require counts and admission timing.",
        path: ["decisionMode"],
      });
    }
    if (transaction.decisionMode === "WEIGHTED" && transaction.batchTotal === 0) {
      context.addIssue({ code: "custom", message: "Weighted batches require vehicles.", path: ["batchTotal"] });
    }
    if (
      (transaction.enteredCount !== undefined && transaction.enteredCount !== transaction.batchTotal) ||
      (transaction.exitedCount !== undefined && transaction.exitedCount !== transaction.batchTotal)
    ) {
      context.addIssue({ code: "custom", message: "Batch entry/exit counts must reconcile.", path: ["enteredCount"] });
    }
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

export type TrafficTransaction = z.infer<typeof trafficTransactionSchema>;
