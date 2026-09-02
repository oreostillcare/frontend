import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);

import { POST } from "./route";

function request(identifier?: string) {
  return new Request("http://localhost/api/auth/resolve-identifier", {
    body: JSON.stringify(identifier === undefined ? {} : { identifier }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("POST /api/auth/resolve-identifier", () => {
  const firestore = createFakeAdminFirestore();

  beforeEach(() => {
    vi.clearAllMocks();
    firestore.clear();
    Object.assign(firebaseAdmin.adminDb, firestore.adminDb);
  });

  it.each([[undefined], ["   "], ["a".repeat(255)]])("rejects a %s identifier", async (identifier) => {
    const response = await POST(request(identifier));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "invalid-input",
      error: "Enter your username or email address.",
    });
  });

  it("returns the same generic credential error for an unknown email", async () => {
    const response = await POST(request("missing@example.com"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "invalid-credential",
      error: "Invalid username/email or password.",
    });
  });

  it("returns the same generic credential error for an unknown username", async () => {
    const response = await POST(request("missing-user"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "invalid-credential",
      error: "Invalid username/email or password.",
    });
  });

  it("normalizes an email identifier before finding the staff account", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      email: "person@example.com",
      normalizedEmail: "person@example.com",
      username: "person",
    });

    const response = await POST(request("PERSON@EXAMPLE.COM"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: "person@example.com" });
  });

  it("matches a normalized username and returns the normalized staff email", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      email: "Person@Example.com",
      normalizedEmail: "person@example.com",
      username: "person",
    });

    const response = await POST(request("PERSON"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: "person@example.com" });
  });

  it.each([
    ["accountStatus", "archived@example.com"],
    ["status", "archived-user"],
  ])("rejects an account archived through %s", async (statusField, identifier) => {
    firestore.seed("staff", "staff-1", {
      email: "archived@example.com",
      normalizedEmail: "archived@example.com",
      [statusField]: "archived",
      username: "archived-user",
    });

    const response = await POST(request(identifier));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "account-archived",
      error: "This staff account is archived. Contact an administrator.",
    });
  });

  it("preserves the current empty-email response for a staff record without an email", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      username: "email-missing",
    });

    const response = await POST(request("email-missing"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: "" });
  });
});
