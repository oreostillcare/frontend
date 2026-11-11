import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({ set: vi.fn(), commit: vi.fn(), collection: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    batch: () => ({ set: firestore.set, commit: firestore.commit }),
    collection: firestore.collection,
  },
}));

import { POST } from "./route";

function completedCycle() {
  const timestamp = "2026-11-03T08:00:00Z";
  return {
    batchPoints: 4,
    batchTotal: 1,
    completedAt: timestamp,
    createdAt: timestamp,
    destinationKey: "nodeB",
    destinationNode: "node-b",
    destinationRemaining: 0,
    greenStartedAt: timestamp,
    sourceCompletedAt: timestamp,
    sourceKey: "nodeA",
    sourceNode: "node-a",
    sourceRemaining: 0,
    status: "complete",
    transactionId: "cycle-1",
    releasedVehicles: [
      {
        class: "car",
        destination: "node-b",
        destinationConfidence: 0.9,
        destinationConfirmedAt: timestamp,
        destinationTrackId: 20,
        gid: "VEH-0001",
        points: 4,
        redTouchedAt: timestamp,
        source: "node-a",
        sourceConfidence: 0.9,
        sourceDetectedAt: timestamp,
        sourceReleasedAt: timestamp,
        sourceTrackId: 10,
        transactionId: "cycle-1",
      },
    ],
  };
}

function request(body: unknown = completedCycle(), secret = "test-secret") {
  return new Request("http://localhost/api/traffic/transactions", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("completed-cycle ingestion remains unchanged", () => {
  beforeEach(() => {
    vi.stubEnv("TRAFFIC_INGEST_SECRET", "test-secret");
    firestore.collection.mockImplementation((collection: string) => ({ doc: (id: string) => `${collection}/${id}` }));
    firestore.commit.mockResolvedValue(undefined);
  });

  it("persists one transaction and one vehicle event with stable document IDs", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(firestore.set).toHaveBeenCalledTimes(2);
    expect(firestore.set.mock.calls[0][0]).toBe("trafficTransactions/cycle-1");
    expect(firestore.set.mock.calls[1][0]).toBe("trafficEvents/cycle-1_VEH-0001");
    expect(firestore.set.mock.calls[1][1]).toMatchObject({
      vehicleId: "VEH-0001",
      vehicleClass: "car",
      nodeId: "node-a",
      destinationNode: "node-b",
    });
    expect(firestore.commit).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ success: true, vehicleCount: 1 });
  });

  it("rejects unauthorized ingestion without writes", async () => {
    expect((await POST(request(completedCycle(), "wrong"))).status).toBe(401);
    expect(firestore.commit).not.toHaveBeenCalled();
  });

  it("does not report success when persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    firestore.commit.mockRejectedValueOnce(new Error("offline"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it("stores a cleared timer batch with no entries after inactivity", async () => {
    const cycle = completedCycle();
    const response = await POST(request({
      ...cycle,
      batchTotal: 0,
      batchPoints: 0,
      releasedVehicles: [],
      decisionMode: "TIMER",
      timerDurationSeconds: 60,
      greenEndedAt: cycle.completedAt,
      enteredCount: 0,
      exitedCount: 0,
      endReason: "incoming_inactivity",
      unusedGreenSeconds: 45,
    }));
    expect(response.status).toBe(200);
    expect(firestore.set.mock.calls[0][1]).toMatchObject({
      decisionMode: "TIMER", enteredCount: 0, exitedCount: 0, unusedGreenSeconds: 45,
    });
  });

  it("rejects a timer batch whose entry and exit totals disagree", async () => {
    const cycle = completedCycle();
    const response = await POST(request({
      ...cycle,
      decisionMode: "TIMER",
      timerDurationSeconds: 60,
      greenEndedAt: cycle.completedAt,
      enteredCount: 1,
      exitedCount: 0,
    }));
    expect(response.status).toBe(400);
    expect(firestore.commit).not.toHaveBeenCalled();
  });

  it("chunks large timer batches and writes their parent after the events", async () => {
    const cycle = completedCycle();
    const vehicles = Array.from({ length: 401 }, (_, index) => ({
      ...cycle.releasedVehicles[0], gid: `vehicle-${index}`,
    }));
    const response = await POST(request({
      ...cycle,
      batchTotal: vehicles.length,
      releasedVehicles: vehicles,
      decisionMode: "TIMER",
      timerDurationSeconds: 60,
      greenEndedAt: cycle.completedAt,
      enteredCount: vehicles.length,
      exitedCount: vehicles.length,
    }));
    expect(response.status).toBe(200);
    expect(firestore.commit).toHaveBeenCalledTimes(2);
    expect(firestore.set.mock.calls.at(-1)?.[0]).toBe("trafficTransactions/cycle-1");
  });
});
