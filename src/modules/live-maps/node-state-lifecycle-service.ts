import { Timestamp } from "firebase-admin/firestore";
// Reads and transitions shared node states while recording lifecycle events in Firestore.
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";

export const nodeIds = ["node-a", "node-b"] as const;
const nodeSchema = z.enum(nodeIds);
const stateSchema = z.enum(["gray", "green", "red"]);
const eventSchema = z.object({
  date: z.string().min(1),
  location: z.string().min(1),
  time: z.string().min(1),
});

export const transitionSchema = z.object({ nodeId: nodeSchema, event: eventSchema, state: stateSchema });
export type NodeTransition = z.infer<typeof transitionSchema>;

type StaffActor = { email: string; role: string };

function serializeState(nodeId: string, data: FirebaseFirestore.DocumentData | undefined) {
  return {
    nodeId,
    state: data?.state === "green" || data?.state === "red" ? data.state : "gray",
    event: data?.event ?? null,
    originLocation: typeof data?.originLocation === "string" ? data.originLocation : null,
    retrievedLocation: typeof data?.retrievedLocation === "string" ? data.retrievedLocation : null,
    sessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
    sessionComplete: data?.sessionComplete === true,
  };
}

export async function readNodeStates() {
  const documents = await Promise.all(nodeIds.map((nodeId) => adminDb.collection("nodeStates").doc(nodeId).get()));
  return documents.map((document, index) => serializeState(nodeIds[index], document.data()));
}

export async function transitionNodeState(transition: NodeTransition, staff: StaffActor) {
  const stateRef = adminDb.collection("nodeStates").doc(transition.nodeId);
  const currentSnapshot = await stateRef.get();
  const current = currentSnapshot.data();
  const otherNodeId = transition.nodeId === "node-a" ? "node-b" : "node-a";
  const otherNodeSnapshot = await adminDb.collection("nodeStates").doc(otherNodeId).get();
  const other = otherNodeSnapshot.data();
  const sessionId =
    transition.state === "green"
      ? other?.state !== "gray" && typeof other?.sessionId === "string"
        ? other.sessionId
        : `session-${Date.now()}`
      : typeof current?.sessionId === "string" && current.sessionId
        ? current.sessionId
        : typeof other?.sessionId === "string" && other.sessionId
          ? other.sessionId
          : `session-${Date.now()}-${transition.nodeId}`;
  const now = Timestamp.now();
  const event =
    transition.state === "green"
      ? "Origin position confirmed"
      : transition.state === "red"
        ? "Compromised"
        : "Retrieved";
  const originLocation =
    transition.state === "green"
      ? transition.event.location
      : typeof current?.originLocation === "string"
        ? current.originLocation
        : transition.event.location;
  const retrievedLocation = transition.state === "gray" ? transition.event.location : null;

  await stateRef.set(
    {
      event: transition.event,
      lastUpdatedAt: now,
      lastUpdatedBy: staff.email,
      nodeId: transition.nodeId,
      originLocation,
      retrievedLocation,
      sessionId,
      state: transition.state,
      updatedByRole: staff.role,
    },
    { merge: true },
  );

  const sessionComplete = transition.state === "gray" && other?.state === "gray";
  await stateRef.set({ sessionComplete }, { merge: true });

  await adminDb.collection("nodeSessionLogs").add({
    actor: staff.email,
    event,
    node: transition.nodeId === "node-a" ? "Node A" : "Node B",
    originLocation,
    retrievedLocation,
    occurredAt: now,
    schemaVersion: 1,
    sessionComplete,
    sessionId,
    source: "live-node-session",
    status:
      transition.state === "red"
        ? "Compromised"
        : transition.state === "gray"
          ? sessionComplete
            ? "Completed"
            : "Active"
          : "Active",
  });
}
