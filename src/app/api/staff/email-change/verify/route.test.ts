import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ collection: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ adminDb: { collection: database.collection }, adminAuth: {} }));

import { GET, POST } from "./route";

const token = "expired-email-verification-fixture";

beforeEach(() => {
  database.get.mockResolvedValue({
    exists: true,
    data: () => ({ status: "expired", expiresAt: Timestamp.fromMillis(1) }),
  });
  database.collection.mockReturnValue({ doc: () => ({ get: database.get, update: database.update }) });
});

it("returns expiry on GET for a request already expired by status polling", async () => {
  const response = await GET(new Request(`http://localhost/api/staff/email-change/verify?token=${token}`));
  expect(response.status).toBe(410);
  await expect(response.json()).resolves.toMatchObject({ code: "expired-token" });
  expect(database.update).not.toHaveBeenCalled();
});

it("returns expiry on POST without reprocessing or writing the terminal request", async () => {
  const response = await POST(
    new Request("http://localhost/api/staff/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  expect(response.status).toBe(410);
  await expect(response.json()).resolves.toMatchObject({ code: "expired-email-change" });
  expect(database.update).not.toHaveBeenCalled();
});
