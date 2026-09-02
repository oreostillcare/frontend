import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    getUserByEmail: vi.fn(),
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    collection: vi.fn(),
  },
}));

vi.mock("./admin", () => firebaseAdmin);

import {
  ApiError,
  authenticateStaff,
  createOpaqueToken,
  errorResponse,
  escapeHtml,
  expiresInHours,
  getRequestOrigin,
  getStaffAuthUid,
  getStaffInvitationExpirationMillis,
  hashToken,
  normalizeEmail,
  requireAdministrator,
} from "./admin-staff";

interface FakeDocument {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

function document(id: string, data?: Record<string, unknown>): FakeDocument {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

function queryResult(documents: FakeDocument[]) {
  return { docs: documents, empty: documents.length === 0 };
}

function configureStaffLookups({
  direct = document("direct"),
  uid = [],
  authUid = [],
  normalizedEmail = [],
  email = [],
}: {
  direct?: FakeDocument;
  uid?: FakeDocument[];
  authUid?: FakeDocument[];
  normalizedEmail?: FakeDocument[];
  email?: FakeDocument[];
} = {}) {
  const results: Record<string, FakeDocument[]> = { authUid, email, normalizedEmail, uid };
  const getDirect = vi.fn().mockResolvedValue(direct);
  const where = vi.fn((field: string) => ({
    limit: vi.fn(() => ({
      get: vi.fn().mockResolvedValue(queryResult(results[field] ?? [])),
    })),
  }));

  firebaseAdmin.adminDb.collection.mockReturnValue({
    doc: vi.fn(() => ({ get: getDirect })),
    where,
  });

  return { getDirect, where };
}

describe("admin staff helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("normalizes email and escapes the HTML characters used in generated messages", () => {
    expect(normalizeEmail("  Staff@Example.COM ")).toBe("staff@example.com");
    expect(escapeHtml('<Admin & "Operator">')).toBe("&lt;Admin &amp; &quot;Operator&quot;&gt;");
  });

  it("creates opaque URL-safe tokens and stable SHA-256 hashes", () => {
    const token = createOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken("same-token")).toBe(hashToken("same-token"));
    expect(hashToken("same-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("same-token")).not.toBe(hashToken("different-token"));
  });

  it("uses APP_BASE_URL when configured and otherwise uses the request origin", () => {
    const request = new Request("https://request.example/api/staff");

    expect(getRequestOrigin(request)).toBe("https://request.example");
    vi.stubEnv("APP_BASE_URL", "https://configured.example");
    expect(getRequestOrigin(request)).toBe("https://configured.example");
  });

  it("calculates hour-based expirations from the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));

    expect(expiresInHours(2).toDate().toISOString()).toBe("2026-09-02T12:00:00.000Z");
  });

  it("uses the earliest of the stored invitation expiry and the one-hour send window", () => {
    const sentAt = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
    const storedExpiry = Timestamp.fromDate(new Date("2026-09-02T13:00:00.000Z"));

    expect(getStaffInvitationExpirationMillis({ expiresAt: storedExpiry, verificationSentAt: sentAt })).toBe(
      Date.parse("2026-09-02T11:00:00.000Z"),
    );
  });

  it("falls back to createdAt when verificationSentAt is missing", () => {
    const createdAt = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));

    expect(getStaffInvitationExpirationMillis({ createdAt })).toBe(Date.parse("2026-09-02T11:00:00.000Z"));
  });
});

describe("staff authentication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    firebaseAdmin.adminAuth.verifyIdToken.mockResolvedValue({ email: "ADMIN@EXAMPLE.COM", uid: "auth-1" });
  });

  it("rejects requests without a bearer token before calling Firebase", async () => {
    await expect(authenticateStaff(new Request("https://app.example/api"))).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
    expect(firebaseAdmin.adminAuth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("authenticates an active direct staff document", async () => {
    configureStaffLookups({
      direct: document("auth-1", {
        accountStatus: "active",
        email: "Admin@Example.com",
        role: "Administrator",
      }),
    });

    const result = await authenticateStaff(
      new Request("https://app.example/api", { headers: { Authorization: "Bearer firebase-token" } }),
    );

    expect(firebaseAdmin.adminAuth.verifyIdToken).toHaveBeenCalledWith("firebase-token");
    expect(result).toMatchObject({ documentId: "auth-1", email: "admin@example.com", role: "Administrator" });
  });

  it("falls back through legacy identifiers to normalized email", async () => {
    const emailDocument = document("legacy-staff", {
      email: "admin@example.com",
      role: "Operator",
    });
    const { where } = configureStaffLookups({ normalizedEmail: [emailDocument] });

    const result = await authenticateStaff(
      new Request("https://app.example/api", { headers: { Authorization: "Bearer token" } }),
    );

    expect(result.documentId).toBe("legacy-staff");
    expect(where.mock.calls.map(([field]) => field)).toEqual(["uid", "authUid", "normalizedEmail"]);
  });

  it("rejects archived accounts", async () => {
    configureStaffLookups({
      direct: document("auth-1", { accountStatus: "archived", role: "Administrator" }),
    });

    await expect(
      authenticateStaff(
        new Request("https://app.example/api", { headers: { Authorization: "Bearer firebase-token" } }),
      ),
    ).rejects.toMatchObject({ code: "inactive-account", status: 403 });
  });

  it("rejects active documents without a supported role", async () => {
    configureStaffLookups({ direct: document("auth-1", { accountStatus: "active", role: "Admin" }) });

    await expect(
      authenticateStaff(
        new Request("https://app.example/api", { headers: { Authorization: "Bearer firebase-token" } }),
      ),
    ).rejects.toMatchObject({ code: "missing-role", status: 403 });
  });

  it("requires the exact Administrator role", async () => {
    configureStaffLookups({ direct: document("auth-1", { accountStatus: "active", role: "Operator" }) });

    await expect(
      requireAdministrator(
        new Request("https://app.example/api", { headers: { Authorization: "Bearer firebase-token" } }),
      ),
    ).rejects.toMatchObject({ code: "administrator-required", status: 403 });
  });
});

describe("staff Auth UID and API errors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("prefers stored UID fields before performing an email lookup", async () => {
    expect(await getStaffAuthUid(document("staff", { uid: "current-uid" }) as never)).toBe("current-uid");
    expect(await getStaffAuthUid(document("staff", { authUid: "legacy-uid" }) as never)).toBe("legacy-uid");
    expect(firebaseAdmin.adminAuth.getUserByEmail).not.toHaveBeenCalled();
  });

  it("resolves a missing UID through Firebase Auth email", async () => {
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ uid: "resolved-uid" });

    await expect(getStaffAuthUid(document("staff", { email: "Staff@Example.com" }) as never)).resolves.toBe(
      "resolved-uid",
    );
    expect(firebaseAdmin.adminAuth.getUserByEmail).toHaveBeenCalledWith("staff@example.com");
  });

  it("maps a failed email lookup to the existing missing-auth-user API error", async () => {
    firebaseAdmin.adminAuth.getUserByEmail.mockRejectedValue(new Error("not found"));

    await expect(getStaffAuthUid(document("staff", { email: "staff@example.com" }) as never)).rejects.toMatchObject({
      code: "missing-auth-user",
      status: 409,
    });
  });

  it("serializes ApiError details into a response", async () => {
    const response = errorResponse(new ApiError("Administrator access is required.", 403, "administrator-required"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "administrator-required",
      error: "Administrator access is required.",
    });
  });

  it.each([
    ["auth/email-already-exists", 409],
    ["auth/user-not-found", 404],
    ["auth/invalid-password", 400],
  ])("maps Firebase Admin error %s to HTTP %i", async (code, status) => {
    const response = errorResponse({ code });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });
});
