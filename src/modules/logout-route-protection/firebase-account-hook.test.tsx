// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
  useAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("firebase/auth", () => ({ signOut: mocks.signOut }));
vi.mock("@/components/auth-provider", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/firebase/client", () => ({ auth: { name: "test-auth" } }));

import { useFirebaseAccount } from "./firebase-account-hook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("account logout", () => {
  it("signs out when activity logging never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const user = { getIdToken: vi.fn().mockResolvedValue("test-token") } as unknown as User;
    mocks.useAuth.mockReturnValue({ user, configured: true, staffProfile: null });
    const { result } = renderHook(() => useFirebaseAccount());

    await act(async () => {
      const logout = result.current.logout();
      await vi.advanceTimersByTimeAsync(1000);
      await logout;
    });

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith("/login");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
