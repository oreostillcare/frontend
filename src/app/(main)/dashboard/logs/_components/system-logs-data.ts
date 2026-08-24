"use client";

import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";

import { db } from "@/lib/firebase/client";

export type SystemEventSeverity = "critical" | "info" | "warning";
export type SystemEventStatus = "active" | "observed" | "resolved";

export interface SystemEvent {
  id: string;
  occurredAt: Date;
  eventType: string;
  category: string;
  component: string;
  severity: SystemEventSeverity;
  message: string;
  eventStatus: SystemEventStatus;
  nodeId: string;
  laneId?: string;
  vehicleCount?: number;
  signal?: "GREEN" | "RED" | "UNKNOWN";
  powerSource?: string;
  batteryPercent?: number;
}

const COLLECTION_NAME = "systemEvents";
const MAX_EVENTS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function readDate(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());

  if (isRecord(value) && typeof value.toDate === "function") {
    try {
      return readDate(value.toDate());
    } catch {
      return null;
    }
  }

  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function readSeverity(value: unknown): SystemEventSeverity {
  if (typeof value !== "string") return "info";
  const severity = value.trim().toLowerCase();
  if (severity === "critical" || severity === "warning") return severity;
  return "info";
}

function readEventStatus(value: unknown): SystemEventStatus {
  if (typeof value !== "string") return "observed";
  const status = value.trim().toLowerCase();
  if (status === "active" || status === "resolved") return status;
  return "observed";
}

function readSignal(value: unknown): SystemEvent["signal"] {
  if (typeof value !== "string") return undefined;
  const signal = value.trim().toUpperCase();
  if (signal === "GREEN" || signal === "RED" || signal === "UNKNOWN") return signal;
  return undefined;
}

function normalizeSystemEvent(id: string, value: unknown): SystemEvent | null {
  if (!isRecord(value)) return null;

  const occurredAt = readDate(value.occurredAt);
  if (!occurredAt) return null;

  const nodeId = readString(value.nodeId ?? value.node, "system")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

  return {
    batteryPercent: readOptionalNumber(value.batteryPercent ?? value.battery),
    category: readString(value.category, "system").toLowerCase(),
    component: readString(value.component, "system"),
    eventStatus: readEventStatus(value.eventStatus ?? value.lifecycle),
    eventType: readString(value.eventType ?? value.type, "system_event")
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
    id,
    laneId: readOptionalString(value.laneId ?? value.lane),
    message: readString(value.message ?? value.event, "System event recorded"),
    nodeId,
    occurredAt,
    powerSource: readOptionalString(value.powerSource),
    severity: readSeverity(value.severity),
    signal: readSignal(value.signal),
    vehicleCount: readOptionalNumber(value.vehicleCount),
  };
}

export function subscribeToSystemEvents(onEvents: (events: SystemEvent[]) => void, onError: (error: Error) => void) {
  if (!db) {
    onError(new Error("Firebase is not configured for this dashboard."));
    return () => undefined;
  }

  const eventsQuery = query(collection(db, COLLECTION_NAME), orderBy("occurredAt", "desc"), limit(MAX_EVENTS));

  return onSnapshot(
    eventsQuery,
    (snapshot) => {
      const events = snapshot.docs
        .map((document) => normalizeSystemEvent(document.id, document.data()))
        .filter((event): event is SystemEvent => event !== null);
      onEvents(events);
    },
    (error) => onError(error),
  );
}
