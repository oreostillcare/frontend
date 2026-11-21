// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  initializeFirebaseAnalytics: vi.fn().mockResolvedValue(null),
  subscribeToStaffProfile: vi.fn(() => vi.fn()),
  recordStaffActivityEvent: vi.fn(),
}));

vi.mock("firebase/auth", () => ({ onAuthStateChanged: mocks.onAuthStateChanged }));
vi.mock("@/lib/firebase/client", () => ({
  auth: { name: "test-auth" },
  initializeFirebaseAnalytics: mocks.initializeFirebaseAnalytics,
  isFirebaseConfigured: true,
}));
vi.mock("@/lib/firebase/staff-access", () => ({
  loadAdministratorEmail: vi.fn(),
  subscribeToStaffProfile: mocks.subscribeToStaffProfile,
}));
vi.mock("@/lib/firebase/staff-activity-client", () => ({
  recordStaffActivityEvent: mocks.recordStaffActivityEvent,
}));

import { AuthProvider } from "./auth-provider";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthProvider browser exit activity", () => {
  it("records one logout when the authenticated page is hidden", async () => {
    const user = { uid: "user-1" } as User;
    mocks.onAuthStateChanged.mockImplementation((_auth, callback) => {
      callback(user);
      return vi.fn();
    });

    render(<AuthProvider>content</AuthProvider>);

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(mocks.recordStaffActivityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordStaffActivityEvent).toHaveBeenCalledWith(user, "logout");
  });
});
