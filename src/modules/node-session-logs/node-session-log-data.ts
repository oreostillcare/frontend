export type NodeId = "Node A" | "Node B";

// Canonical types for origin, compromised, and retrieval session-log records.
export type SessionEvent = "Origin position confirmed" | "Retrieved" | "Compromised";
export type SessionStatus = "Active" | "Compromised" | "Completed";

export type SessionLog = {
  actor: string;
  event: SessionEvent;
  id: string;
  node: NodeId;
  originLocation: string;
  retrievedLocation: string | null;
  status: SessionStatus;
  timestamp: string;
  timestampLabel: string;
};

export function timestampToDate(value: unknown) {
  if (typeof value === "string") return new Date(value);
  return null;
}

export function manilaDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Manila",
    year: "numeric",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function mapFirestoreLog(id: string, data: Record<string, unknown>): SessionLog | null {
  const node = data.node === "Node A" || data.node === "Node B" ? data.node : null;
  const event =
    data.event === "Origin position confirmed" || data.event === "Retrieved" || data.event === "Compromised"
      ? data.event
      : null;
  const status =
    data.status === "Active" || data.status === "Compromised" || data.status === "Completed" ? data.status : null;
  const occurredAt = timestampToDate(data.occurredAt);
  if (!node || !event || !status || !occurredAt) return null;

  return {
    actor: typeof data.actor === "string" ? data.actor : "System",
    event,
    id,
    node,
    originLocation: typeof data.originLocation === "string" ? data.originLocation : "--",
    retrievedLocation: typeof data.retrievedLocation === "string" ? data.retrievedLocation : null,
    status,
    timestamp: occurredAt.toISOString(),
    timestampLabel: occurredAt.toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }),
  };
}

export const originLocations: Record<NodeId, string> = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94098, 121.16204)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94188, 121.16442)",
};

export const retrievedLocations: Record<NodeId, string> = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94112, 121.16230)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94190, 121.16430)",
};
