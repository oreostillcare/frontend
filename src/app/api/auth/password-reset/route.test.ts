import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/lib/firebase/admin-staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/admin-staff")>();
  return {
    ...actual,
    createOpaqueToken: vi.fn(() => "phase1-reset-request-token-000000"),
  };
});

import { hashToken } from "@/lib/firebase/admin-staff";

import { DELETE, GET, PATCH, POST } from "./route";

type StoredDocument = Record<string, unknown>;

interface FakeReference {
  collectionName: string;
  id: string;
  delete: () => Promise<void>;
  get: () => Promise<FakeSnapshot>;
  set: (data: StoredDocument) => Promise<void>;
  update: (data: StoredDocument) => Promise<void>;
}

interface FakeSnapshot {
  data: () => StoredDocument | undefined;
  exists: boolean;
  id: string;
  ref: FakeReference;
}

function createFakeFirestore() {
  const records = new Map<string, StoredDocument>();
  const keyFor = (collectionName: string, id: string) => `${collectionName}/${id}`;

  const reference = (collectionName: string, id: string): FakeReference => {
    const key = keyFor(collectionName, id);
    const ref = {
      collectionName,
      id,
      delete: vi.fn(async () => {
        records.delete(key);
      }),
      get: vi.fn(async (): Promise<FakeSnapshot> => {
        const stored = records.get(key);
        return { data: () => stored, exists: stored !== undefined, id, ref };
      }),
      set: vi.fn(async (data: StoredDocument) => {
        records.set(key, { ...data });
      }),
      update: vi.fn(async (data: StoredDocument) => {
        const current = records.get(key) ?? {};
        records.set(key, { ...current, ...data });
      }),
    } satisfies FakeReference;
    return ref;
  };

  const queryDocuments = async (collectionName: string, field: string, value: unknown) => {
    const documents: FakeSnapshot[] = [];
    for (const [key, data] of records) {
      const [storedCollection, id] = key.split("/");
      if (storedCollection !== collectionName || data[field] !== value || !id) continue;
      const ref = reference(collectionName, id);
      documents.push({ data: () => data, exists: true, id, ref });
    }
    return { docs: documents, empty: documents.length === 0 };
  };

  const collection = vi.fn((collectionName: string) => ({
    doc: vi.fn((id: string) => reference(collectionName, id)),
    where: vi.fn((field: string, _operator: string, value: unknown) => ({
      limit: vi.fn(() => ({
        get: vi.fn(() => queryDocuments(collectionName, field, value)),
      })),
    })),
  }));

  const transaction = {
    get: vi.fn((ref: FakeReference) => ref.get()),
    set: vi.fn((ref: FakeReference, data: StoredDocument) => ref.set(data)),
    update: vi.fn((ref: FakeReference, data: StoredDocument) => ref.update(data)),
  };
  const runTransaction = vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction));

  return {
    collection,
    get(collectionName: string, id: string) {
      return records.get(keyFor(collectionName, id));
    },
    runTransaction,
    seed(collectionName: string, id: string, data: StoredDocument) {
      records.set(keyFor(collectionName, id), { ...data });
    },
    transaction,
  };
}

function request(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
}

function activeStaff(overrides: StoredDocument = {}) {
  return {
    accountStatus: "active",
    email: "staff@example.com",
    normalizedEmail: "staff@example.com",
    role: "Operator",
    uid: "staff-auth-uid",
    ...overrides,
  };
}

function activeSession(requestIdHash: string, overrides: StoredDocument = {}) {
  return {
    baselineValidAfterTime: Date.parse("2026-09-02T08:00:00.000Z"),
    createdAt: Timestamp.fromDate(new Date("2026-09-02T09:59:00.000Z")),
    email: "staff@example.com",
    expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:04:00.000Z")),
    requestedAt: Timestamp.fromDate(new Date("2026-09-02T09:59:00.000Z")),
    staffId: "staff-1",
    staffUid: "staff-auth-uid",
    status: "active",
    ...overrides,
    requestIdHash,
  };
}

describe("password reset route", () => {
  let firestore: ReturnType<typeof createFakeFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    firestore = createFakeFirestore();
    firebaseAdmin.adminDb.collection = firestore.collection;
    firebaseAdmin.adminDb.runTransaction = firestore.runTransaction;
    firebaseAdmin.adminAuth.getUser.mockResolvedValue({
      tokensValidAfterTime: "2026-09-02T08:00:00.000Z",
      uid: "staff-auth-uid",
    });
  });

  describe("POST", () => {
    it("rejects invalid email input", async () => {
      const response = await POST(request("POST", "https://app.example/api/auth/password-reset", { email: "bad" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "invalid-email" });
    });

    it("rejects an unknown staff email", async () => {
      const response = await POST(
        request("POST", "https://app.example/api/auth/password-reset", { email: "unknown@example.com" }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: "staff-not-found" });
    });

    it("rejects an archived staff account", async () => {
      firestore.seed("staff", "staff-1", activeStaff({ accountStatus: "archived" }));

      const response = await POST(
        request("POST", "https://app.example/api/auth/password-reset", { email: "STAFF@example.com" }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "account-archived" });
    });

    it("creates a hashed reset session and marks the staff reset pending", async () => {
      firestore.seed("staff", "staff-1", activeStaff());

      const response = await POST(
        request("POST", "https://app.example/api/auth/password-reset", { email: "STAFF@EXAMPLE.COM" }),
      );
      const payload = (await response.json()) as { cooldownEndsAt: string; expiresAt: string; requestId: string };
      const requestIdHash = hashToken(payload.requestId);

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        cooldownEndsAt: "2026-09-02T10:03:00.000Z",
        expiresAt: "2026-09-02T10:05:00.000Z",
        requestId: "phase1-reset-request-token-000000",
      });
      expect(firestore.get("passwordResetSessions", requestIdHash)).toMatchObject({
        email: "staff@example.com",
        status: "active",
      });
      expect(firestore.get("staff", "staff-1")).toMatchObject({
        passwordResetRequestId: requestIdHash,
        passwordResetStatus: "pending",
      });
    });

    it("enforces the three-minute resend cooldown", async () => {
      firestore.seed(
        "staff",
        "staff-1",
        activeStaff({ passwordResetRequestedAt: Timestamp.fromDate(new Date("2026-09-02T09:58:00.000Z")) }),
      );

      const response = await POST(
        request("POST", "https://app.example/api/auth/password-reset", { email: "staff@example.com" }),
      );

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        code: "reset-cooldown",
        cooldownEndsAt: "2026-09-02T10:01:00.000Z",
      });
    });

    it("allows a new request exactly at the cooldown boundary and cancels the previous active request", async () => {
      firestore.seed(
        "staff",
        "staff-1",
        activeStaff({
          passwordResetRequestId: "previous-session",
          passwordResetRequestedAt: Timestamp.fromDate(new Date("2026-09-02T09:57:00.000Z")),
        }),
      );
      firestore.seed("passwordResetSessions", "previous-session", {
        staffId: "staff-1",
        status: "active",
      });

      const response = await POST(
        request("POST", "https://app.example/api/auth/password-reset", { email: "staff@example.com" }),
      );

      expect(response.status).toBe(200);
      expect(firestore.get("passwordResetSessions", "previous-session")).toMatchObject({
        cancellationReason: "replaced",
        status: "cancelled",
      });
    });
  });

  describe("GET", () => {
    it("requires a reset request ID", async () => {
      const response = await GET(request("GET", "https://app.example/api/auth/password-reset"));

      expect(response.status).toBe(400);
    });

    it("returns active while Firebase has not confirmed a password change", async () => {
      const requestId = "active-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await GET(request("GET", `https://app.example/api/auth/password-reset?requestId=${requestId}`));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        requestedAt: "2026-09-02T09:59:00.000Z",
        status: "active",
      });
    });

    it("expires a request at the exact expiration boundary", async () => {
      const requestId = "expired-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed(
        "passwordResetSessions",
        requestIdHash,
        activeSession(requestIdHash, { expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z")) }),
      );
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await GET(request("GET", `https://app.example/api/auth/password-reset?requestId=${requestId}`));

      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ code: "expired-reset-request" });
      expect(firestore.get("passwordResetSessions", requestIdHash)).toMatchObject({
        cancellationReason: "expired",
        status: "cancelled",
      });
    });

    it("completes the latest request after Firebase advances tokensValidAfterTime", async () => {
      const requestId = "completed-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));
      firebaseAdmin.adminAuth.getUser.mockResolvedValue({
        tokensValidAfterTime: "2026-09-02T09:00:00.000Z",
        uid: "staff-auth-uid",
      });

      const response = await GET(request("GET", `https://app.example/api/auth/password-reset?requestId=${requestId}`));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        completedAt: "2026-09-02T10:00:00.000Z",
        status: "completed",
      });
      expect(firestore.get("passwordResetSessions", requestIdHash)).toMatchObject({ status: "completed" });
      expect(firestore.get("staff", "staff-1")).toMatchObject({ passwordResetStatus: "completed" });
    });
  });

  describe("PATCH", () => {
    it("rejects a claim when the submitted email does not match the session", async () => {
      const requestId = "claim-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await PATCH(
        request("PATCH", "https://app.example/api/auth/password-reset", {
          action: "claim",
          email: "other@example.com",
          requestId,
        }),
      );

      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ code: "reset-email-mismatch" });
    });

    it("records a processing claim for the latest active request", async () => {
      const requestId = "claim-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await PATCH(
        request("PATCH", "https://app.example/api/auth/password-reset", {
          action: "claim",
          email: "STAFF@EXAMPLE.COM",
          requestId,
        }),
      );

      expect(response.status).toBe(200);
      expect(firestore.get("passwordResetSessions", requestIdHash)?.processingStartedAt).toBeInstanceOf(Timestamp);
    });

    it("refuses completion until Firebase confirms the password change", async () => {
      const requestId = "complete-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed(
        "passwordResetSessions",
        requestIdHash,
        activeSession(requestIdHash, { processingStartedAt: Timestamp.now() }),
      );
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await PATCH(
        request("PATCH", "https://app.example/api/auth/password-reset", {
          action: "complete",
          email: "staff@example.com",
          requestId,
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "password-change-not-confirmed" });
    });

    it("requires a prior claim even after Firebase confirms the change", async () => {
      const requestId = "complete-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));
      firebaseAdmin.adminAuth.getUser.mockResolvedValue({
        tokensValidAfterTime: "2026-09-02T09:00:00.000Z",
        uid: "staff-auth-uid",
      });

      const response = await PATCH(
        request("PATCH", "https://app.example/api/auth/password-reset", {
          action: "complete",
          email: "staff@example.com",
          requestId,
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "reset-not-claimed" });
    });
  });

  describe("DELETE", () => {
    it("cancels an active request and marks the matching staff reset failed", async () => {
      const requestId = "cancel-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed("passwordResetSessions", requestIdHash, activeSession(requestIdHash));
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await DELETE(request("DELETE", "https://app.example/api/auth/password-reset", { requestId }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "cancelled" });
      expect(firestore.get("passwordResetSessions", requestIdHash)).toMatchObject({
        cancellationReason: "cancelled",
        status: "cancelled",
      });
      expect(firestore.get("staff", "staff-1")).toMatchObject({ passwordResetStatus: "failed" });
    });

    it("does not cancel a request with an active processing lease", async () => {
      const requestId = "processing-reset-request-token";
      const requestIdHash = hashToken(requestId);
      firestore.seed(
        "passwordResetSessions",
        requestIdHash,
        activeSession(requestIdHash, { processingStartedAt: Timestamp.fromDate(new Date("2026-09-02T09:59:59Z")) }),
      );
      firestore.seed("staff", "staff-1", activeStaff({ passwordResetRequestId: requestIdHash }));

      const response = await DELETE(request("DELETE", "https://app.example/api/auth/password-reset", { requestId }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "reset-in-progress" });
      expect(firestore.get("passwordResetSessions", requestIdHash)).toMatchObject({ status: "active" });
    });
  });
});
