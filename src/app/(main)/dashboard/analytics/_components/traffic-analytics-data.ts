"use client";

import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { z } from "zod";

import { db } from "@/lib/firebase/client";

export type TrafficNodeFilter = "all" | "node-a" | "node-b";
export type TrafficRange = "24h" | "7d" | "30d";
export type TrafficDataSource = "firestore" | "sample";

export interface TrafficSubscriptionOptions {
  specificDate?: Date;
}

type TrafficNodeId = Exclude<TrafficNodeFilter, "all">;

export interface TrafficEvent {
  id: string;
  vehicleClass: string;
  vehicleId: string;
  nodeId: TrafficNodeId;
  laneId: string;
  occurredAt: Date;
  confidence: number | null;
  direction?: string;
}

export interface TrafficVolumePoint {
  period: number;
  label: string;
  nodeA: number;
  nodeB: number;
  total: number;
}

export interface VehicleClassPoint {
  vehicleClass: string;
  label: string;
  nodeA: number;
  nodeB: number;
  total: number;
}

export interface HourlyActivityPoint {
  hour: number;
  label: string;
  nodeA: number;
  nodeB: number;
  total: number;
}

export interface TrafficMetrics {
  total: number;
  busiestNode: "Node A" | "Node B" | "--";
  busiestNodeCount: number;
  peakHour: string;
  peakHourCount: number;
  topClass: string;
  topClassCount: number;
  averageConfidence: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MANILA_OFFSET_MS = 8 * HOUR_MS;

const VEHICLE_CLASSES = [
  "ambulance",
  "bicycle",
  "bus",
  "car",
  "ebike",
  "etrike",
  "firetruck",
  "jeepney",
  "motorcycle",
  "multicab",
  "pickup",
  "police",
  "sedan",
  "suv",
  "tricycle",
  "truck",
  "van",
] as const;

type VehicleClass = (typeof VEHICLE_CLASSES)[number];

const VEHICLE_CLASS_LABELS: Record<VehicleClass, string> = {
  ambulance: "Ambulance",
  bicycle: "Bicycle",
  bus: "Bus",
  car: "Car",
  ebike: "E-bike",
  etrike: "E-trike",
  firetruck: "Fire truck",
  jeepney: "Jeepney",
  motorcycle: "Motorcycle",
  multicab: "Multicab",
  pickup: "Pickup",
  police: "Police vehicle",
  sedan: "Sedan",
  suv: "SUV",
  tricycle: "Tricycle",
  truck: "Truck",
  van: "Van",
};

const SAMPLE_CLASS_CYCLE: readonly VehicleClass[] = [
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
  "bicycle",
  "multicab",
  "ambulance",
  "firetruck",
  "police",
];

const manilaHourFormatter = new Intl.DateTimeFormat("en-PH", {
  hour: "numeric",
  timeZone: "Asia/Manila",
});

const manilaWeekdayFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  weekday: "short",
});

const manilaMonthDayFormatter = new Intl.DateTimeFormat("en-PH", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Manila",
});

const manilaHourNumberFormatter = new Intl.DateTimeFormat("en-PH", {
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Manila",
});

const manilaDatePartsFormatter = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Manila",
  year: "numeric",
});

const manilaFullDateFormatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeZone: "Asia/Manila",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVehicleClass(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const aliases: Record<string, VehicleClass> = {
    ambulance: "ambulance",
    bicycle: "bicycle",
    bike: "bicycle",
    bus: "bus",
    car: "car",
    ebike: "ebike",
    electricbike: "ebike",
    electrictricycle: "etrike",
    emergencyambulance: "ambulance",
    etrike: "etrike",
    fireengine: "firetruck",
    firetruck: "firetruck",
    jeep: "jeepney",
    jeepney: "jeepney",
    motorbike: "motorcycle",
    motorcycle: "motorcycle",
    multicab: "multicab",
    pickup: "pickup",
    pickuptruck: "pickup",
    police: "police",
    policecar: "police",
    policevehicle: "police",
    sedan: "sedan",
    suv: "suv",
    tricycle: "tricycle",
    truck: "truck",
    van: "van",
  };

  return aliases[compact] ?? compact;
}

function normalizeNodeId(value: unknown): unknown {
  if (value === 1) return "node-a";
  if (value === 2) return "node-b";
  if (typeof value !== "string") return value;

  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (["1", "a", "camera-a", "lane-a", "node-a", "nodea"].includes(compact)) return "node-a";
  if (["2", "b", "camera-b", "lane-b", "node-b", "nodeb"].includes(compact)) return "node-b";
  return compact;
}

function normalizeLaneId(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return normalized || value;
}

function normalizeDate(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : new Date(value.getTime());

  if (isRecord(value) && typeof value.toDate === "function") {
    try {
      return normalizeDate(value.toDate());
    } catch {
      return value;
    }
  }

  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }

  return value;
}

function normalizeConfidence(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return value;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric > 1 && numeric <= 100 ? numeric / 100 : numeric;
}

function normalizeDirection(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

const trafficEventSchema = z.object({
  confidence: z.preprocess(normalizeConfidence, z.number().min(0).max(1).nullable()),
  direction: z.preprocess(normalizeDirection, z.string().min(1).optional()),
  id: z.string().min(1),
  laneId: z.preprocess(normalizeLaneId, z.string().min(1)),
  nodeId: z.preprocess(normalizeNodeId, z.enum(["node-a", "node-b"])),
  occurredAt: z.preprocess(normalizeDate, z.date()),
  vehicleClass: z.preprocess(normalizeVehicleClass, z.enum(VEHICLE_CLASSES)),
  vehicleId: z.coerce.string().min(1),
});

function normalizeEventDocument(id: string, value: unknown): unknown {
  if (!isRecord(value)) return value;

  const nodeId = normalizeNodeId(value.nodeId ?? value.node ?? value.cameraId ?? value.laneId ?? value.lane);
  const defaultLaneId = nodeId === "node-b" ? "lane-b" : "lane-a";

  return {
    confidence: value.confidence ?? value.score ?? null,
    direction: value.direction,
    id,
    laneId: value.laneId ?? value.lane ?? defaultLaneId,
    nodeId,
    occurredAt: value.occurredAt ?? value.timestamp ?? value.crossedAt ?? value.createdAt,
    vehicleClass: value.vehicleClass ?? value.class ?? value.className,
    vehicleId: value.vehicleId ?? value.trackId ?? value.idNumber ?? id,
  };
}

function parseTrafficEvent(id: string, value: unknown): TrafficEvent | null {
  const result = trafficEventSchema.safeParse(normalizeEventDocument(id, value));
  if (!result.success) return null;
  return result.data;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unable to load traffic history from Firestore.");
}

function createSampleEvents(now: Date): TrafficEvent[] {
  const anchor = new Date(now);
  anchor.setSeconds(0, 0);
  const events: TrafficEvent[] = [];
  const recentEventCount = 128;
  const olderEventCount = 320;
  const olderSpanMinutes = 29 * 24 * 60;

  for (let index = 0; index < recentEventCount + olderEventCount; index += 1) {
    const minutesAgo =
      index < recentEventCount
        ? index * 11 + ((index * 7) % 4)
        : 24 * 60 + Math.round(((index - recentEventCount) * olderSpanMinutes) / (olderEventCount - 1));
    const occurredAt = new Date(anchor.getTime() - minutesAgo * 60 * 1000);
    const nodeId: TrafficNodeId = (index * 7 + Math.floor(index / 5)) % 10 < 6 ? "node-a" : "node-b";
    const vehicleClass = SAMPLE_CLASS_CYCLE[(index * 5 + Math.floor(index / 7)) % SAMPLE_CLASS_CYCLE.length];
    const confidence = Math.min(0.98, 0.67 + ((index * 17) % 30) / 100);

    events.push({
      confidence: Math.round(confidence * 100) / 100,
      direction: index % 4 === 0 ? "reverse" : "forward",
      id: `sample-${anchor.getTime()}-${index}`,
      laneId: nodeId === "node-a" ? "lane-a" : "lane-b",
      nodeId,
      occurredAt,
      vehicleClass,
      vehicleId: `TMS-${String(10_000 + index).padStart(5, "0")}`,
    });
  }

  return events.sort((first, second) => second.occurredAt.getTime() - first.occurredAt.getTime());
}

export function subscribeToTrafficEvents(
  onData: (events: TrafficEvent[], source: TrafficDataSource) => void,
  onError: (error: Error) => void,
  options: TrafficSubscriptionOptions = {},
): () => void {
  const specificDay = options.specificDate ? getManilaDayBounds(options.specificDate) : null;
  const sampleAnchor = specificDay ? new Date(specificDay.endExclusive - 1) : new Date();
  const emitSampleData = () => onData(createSampleEvents(sampleAnchor), "sample");

  if (!db) {
    emitSampleData();
    return () => undefined;
  }

  try {
    const trafficEventsQuery = specificDay
      ? query(
          collection(db, "trafficEvents"),
          where("occurredAt", ">=", new Date(specificDay.start)),
          where("occurredAt", "<", new Date(specificDay.endExclusive)),
          orderBy("occurredAt", "desc"),
        )
      : query(collection(db, "trafficEvents"), orderBy("occurredAt", "desc"), limit(500));

    return onSnapshot(
      trafficEventsQuery,
      (snapshot) => {
        if (snapshot.empty) {
          if (specificDay) {
            onData([], "firestore");
            return;
          }

          emitSampleData();
          return;
        }

        const events = snapshot.docs
          .map((document) => parseTrafficEvent(document.id, document.data()))
          .filter((event): event is TrafficEvent => event !== null)
          .sort((first, second) => second.occurredAt.getTime() - first.occurredAt.getTime());

        if (events.length === 0) {
          onError(new Error("Traffic history exists, but none of its records use the supported schema."));
          emitSampleData();
          return;
        }

        onData(events, "firestore");
      },
      (cause) => {
        onError(asError(cause));
        emitSampleData();
      },
    );
  } catch (cause) {
    onError(asError(cause));
    emitSampleData();
    return () => undefined;
  }
}

function rangeStart(range: TrafficRange, now: Date): number {
  if (range === "24h") return now.getTime() - DAY_MS;
  const dayCount = range === "7d" ? 7 : 30;
  return startOfManilaDay(now) - (dayCount - 1) * DAY_MS;
}

export function getManilaDayBounds(date: Date): { start: number; endExclusive: number } {
  const parts = manilaDatePartsFormatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const start = Date.UTC(year, month - 1, day) - MANILA_OFFSET_MS;

  return { endExclusive: start + DAY_MS, start };
}

export function formatManilaDate(date: Date): string {
  return manilaFullDateFormatter.format(new Date(getManilaDayBounds(date).start));
}

export function filterTrafficEvents(
  events: TrafficEvent[],
  range: TrafficRange,
  nodeFilter: TrafficNodeFilter,
  now: Date,
  specificDate?: Date,
): TrafficEvent[] {
  const specificDay = specificDate ? getManilaDayBounds(specificDate) : null;
  const start = specificDay?.start ?? rangeStart(range, now);
  const end = specificDay?.endExclusive ?? now.getTime();

  return events
    .filter((event) => {
      const timestamp = event.occurredAt.getTime();
      const isInPeriod = specificDay ? timestamp >= start && timestamp < end : timestamp >= start && timestamp <= end;
      return isInPeriod && (nodeFilter === "all" || event.nodeId === nodeFilter);
    })
    .sort((first, second) => second.occurredAt.getTime() - first.occurredAt.getTime());
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function getManilaHour(date: Date): number {
  return Number(manilaHourNumberFormatter.format(date));
}

function startOfManilaDay(date: Date): number {
  return Math.floor((date.getTime() + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
}

export function buildHourlyActivitySeries(events: TrafficEvent[]): HourlyActivityPoint[] {
  const series = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: formatHour(hour),
    nodeA: 0,
    nodeB: 0,
    total: 0,
  }));

  for (const event of events) {
    const point = series[getManilaHour(event.occurredAt)];
    if (!point) continue;
    if (event.nodeId === "node-a") point.nodeA += 1;
    else point.nodeB += 1;
    point.total += 1;
  }

  return series;
}

export function formatVehicleClass(vehicleClass: string): string {
  const normalized = normalizeVehicleClass(vehicleClass);
  if (typeof normalized === "string" && normalized in VEHICLE_CLASS_LABELS) {
    return VEHICLE_CLASS_LABELS[normalized as VehicleClass];
  }

  return vehicleClass
    .trim()
    .replace(/[\s_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildClassificationSeries(events: TrafficEvent[]): VehicleClassPoint[] {
  const counts = new Map<string, { nodeA: number; nodeB: number }>(
    VEHICLE_CLASSES.map((vehicleClass) => [vehicleClass, { nodeA: 0, nodeB: 0 }]),
  );

  for (const event of events) {
    const normalized = normalizeVehicleClass(event.vehicleClass);
    const vehicleClass = typeof normalized === "string" ? normalized : event.vehicleClass;
    const count = counts.get(vehicleClass) ?? { nodeA: 0, nodeB: 0 };
    if (event.nodeId === "node-a") count.nodeA += 1;
    else count.nodeB += 1;
    counts.set(vehicleClass, count);
  }

  return Array.from(counts, ([vehicleClass, count]) => ({
    label: formatVehicleClass(vehicleClass),
    nodeA: count.nodeA,
    nodeB: count.nodeB,
    total: count.nodeA + count.nodeB,
    vehicleClass,
  }))
    .filter((point) => point.total > 0)
    .sort((first, second) => second.total - first.total || first.label.localeCompare(second.label))
    .slice(0, 8);
}

export function buildVolumeSeries(
  events: TrafficEvent[],
  range: TrafficRange,
  specificDate?: Date,
): TrafficVolumePoint[] {
  const now = new Date();
  const specificDay = specificDate ? getManilaDayBounds(specificDate) : null;
  const hourly = range === "24h" || specificDay !== null;
  const periodMs = hourly ? HOUR_MS : DAY_MS;
  let periodCount = 30;
  if (hourly) periodCount = 24;
  else if (range === "7d") periodCount = 7;

  let currentPeriod = startOfManilaDay(now);
  if (specificDay) currentPeriod = specificDay.endExclusive - HOUR_MS;
  else if (hourly) currentPeriod = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;

  const firstPeriod = specificDay?.start ?? currentPeriod - (periodCount - 1) * periodMs;
  const series = Array.from({ length: periodCount }, (_, index) => {
    const period = firstPeriod + index * periodMs;
    const date = new Date(period);
    let label = manilaMonthDayFormatter.format(date);
    if (hourly) label = manilaHourFormatter.format(date);
    else if (range === "7d") label = manilaWeekdayFormatter.format(date);

    return { label, nodeA: 0, nodeB: 0, period, total: 0 };
  });

  for (const event of events) {
    const eventPeriod = hourly
      ? Math.floor(event.occurredAt.getTime() / HOUR_MS) * HOUR_MS
      : startOfManilaDay(event.occurredAt);
    const index = Math.floor((eventPeriod - firstPeriod) / periodMs);
    const point = series[index];
    if (!point || eventPeriod > currentPeriod) continue;
    if (event.nodeId === "node-a") point.nodeA += 1;
    else point.nodeB += 1;
    point.total += 1;
  }

  return series;
}

export function buildTrafficMetrics(events: TrafficEvent[]): TrafficMetrics {
  if (events.length === 0) {
    return {
      averageConfidence: null,
      busiestNode: "--",
      busiestNodeCount: 0,
      peakHour: "--",
      peakHourCount: 0,
      topClass: "--",
      topClassCount: 0,
      total: 0,
    };
  }

  const nodeACount = events.filter((event) => event.nodeId === "node-a").length;
  const nodeBCount = events.length - nodeACount;
  const peakHour = buildHourlyActivitySeries(events).reduce((peak, point) => (point.total > peak.total ? point : peak));
  const topClass = buildClassificationSeries(events).reduce((top, point) => (point.total > top.total ? point : top));
  const confidences = events.flatMap((event) => (event.confidence === null ? [] : [event.confidence]));
  const averageConfidence =
    confidences.length === 0
      ? null
      : Math.round((confidences.reduce((total, confidence) => total + confidence, 0) / confidences.length) * 1000) /
        1000;

  return {
    averageConfidence,
    busiestNode: nodeACount >= nodeBCount ? "Node A" : "Node B",
    busiestNodeCount: Math.max(nodeACount, nodeBCount),
    peakHour: peakHour.label,
    peakHourCount: peakHour.total,
    topClass: topClass.label,
    topClassCount: topClass.total,
    total: events.length,
  };
}
