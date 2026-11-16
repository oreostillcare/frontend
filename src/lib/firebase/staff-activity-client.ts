import type { User } from "firebase/auth";

export async function recordStaffActivityEvent(user: User | null, event: "login" | "logout") {
  if (!user) return;

  try {
    const token = await user.getIdToken();
    await fetch("/api/staff/activity", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event }),
      keepalive: event === "logout",
    });
  } catch {
    // Activity logging must not block authentication or logout.
  }
}
