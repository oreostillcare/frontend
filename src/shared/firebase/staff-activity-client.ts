import type { User } from "firebase/auth";

export async function recordStaffActivityEvent(user: User | null, event: "login" | "logout") {
  if (!user) return;

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const token = await user.getIdToken();
        if (controller.signal.aborted) return;
        await fetch("/api/staff/activity", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event }),
          keepalive: event === "logout",
          signal: controller.signal,
        });
      })(),
      // Bound token acquisition too; abort alone cannot settle a pending token request.
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1000);
      }),
    ]);
  } catch {
    // Activity logging must not block authentication or logout.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
