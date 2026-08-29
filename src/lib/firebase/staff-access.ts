import type { User } from "firebase/auth";
import { collection, doc, onSnapshot, query, type Timestamp, where } from "firebase/firestore";

import { db } from "./client";

export type StaffRole = "Administrator" | "Operator";

export interface StaffProfile {
  id: string;
  username: string;
  email: string;
  role: StaffRole;
  dateJoined?: string;
  accountStatus: "active" | "archived";
  passwordResetStatus?: "idle" | "pending" | "completed" | "failed";
  passwordResetRequestedAt?: string;
  passwordResetCompletedAt?: string;
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRole(value: unknown): StaffRole | null {
  const role = getString(value).toLowerCase();
  if (role === "administrator" || role === "admin") return "Administrator";
  if (role === "operator") return "Operator";
  return null;
}

function timestampToIso(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as Timestamp).toDate().toISOString();
  }
  return getString(value) || undefined;
}

function mapProfile(id: string, data: Record<string, unknown>, user: User): StaffProfile | null {
  const role = normalizeRole(data.role);
  const accountStatus = data.accountStatus === "archived" || data.status === "archived" ? "archived" : "active";
  const emailVerified = data.emailVerified !== false && data.status !== "pending";
  if (!role || accountStatus === "archived" || !emailVerified) return null;

  const email = getString(data.email) || user.email || "";
  const passwordResetRequestedAt = timestampToIso(data.passwordResetRequestedAt);
  const passwordResetCompletedAt = timestampToIso(data.passwordResetCompletedAt);
  let inferredPasswordResetStatus: "idle" | "pending" | "completed" = "idle";
  if (passwordResetRequestedAt) inferredPasswordResetStatus = "pending";
  if (passwordResetCompletedAt) inferredPasswordResetStatus = "completed";
  return {
    id,
    username: getString(data.username) || user.displayName?.trim() || email.split("@")[0],
    email,
    role,
    dateJoined: getString(data.dateJoined) || timestampToIso(data.createdAt)?.slice(0, 10),
    accountStatus,
    passwordResetStatus:
      data.passwordResetStatus === "pending" ||
      data.passwordResetStatus === "completed" ||
      data.passwordResetStatus === "failed"
        ? data.passwordResetStatus
        : inferredPasswordResetStatus,
    passwordResetRequestedAt,
    passwordResetCompletedAt,
  };
}

export function subscribeToStaffProfile(
  user: User,
  onProfile: (profile: StaffProfile | null) => void,
  onError: (error: Error) => void,
) {
  if (!db || !user.email) {
    onProfile(null);
    return () => undefined;
  }

  const sources = new Map<string, StaffProfile | null>();
  const ready = new Set<string>();
  const staffRef = collection(db, "staff");
  const normalizedEmail = user.email.trim().toLowerCase();

  const publish = () => {
    if (ready.size < 3) return;
    onProfile(sources.get("direct") ?? sources.get("uid") ?? sources.get("email") ?? null);
  };

  const directUnsubscribe = onSnapshot(
    doc(db, "staff", user.uid),
    (snapshot) => {
      sources.set("direct", snapshot.exists() ? mapProfile(snapshot.id, snapshot.data(), user) : null);
      ready.add("direct");
      publish();
    },
    onError,
  );
  const uidUnsubscribe = onSnapshot(
    query(staffRef, where("authUid", "==", user.uid)),
    (snapshot) => {
      const document = snapshot.docs[0];
      sources.set("uid", document ? mapProfile(document.id, document.data(), user) : null);
      ready.add("uid");
      publish();
    },
    onError,
  );
  const emailUnsubscribe = onSnapshot(
    query(staffRef, where("normalizedEmail", "==", normalizedEmail)),
    (snapshot) => {
      const document = snapshot.docs[0];
      sources.set("email", document ? mapProfile(document.id, document.data(), user) : null);
      ready.add("email");
      publish();
    },
    onError,
  );

  return () => {
    directUnsubscribe();
    uidUnsubscribe();
    emailUnsubscribe();
  };
}

export async function loadAdministratorEmail(user: User) {
  const token = await user.getIdToken();
  const response = await fetch("/api/staff/administrator-contact", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { email?: string | null };
  return payload.email ?? null;
}
