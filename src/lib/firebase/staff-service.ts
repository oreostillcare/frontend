import { collection, onSnapshot, type Timestamp } from "firebase/firestore";

import type { StaffMember, StaffRole } from "@/app/(main)/dashboard/staff/_components/staff-types";

import { db } from "./client";

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function timestampToIso(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as Timestamp).toDate().toISOString();
  }
  return getString(value) || undefined;
}

function getDateJoined(value: unknown, createdAt: unknown) {
  const directDate = getString(value);
  if (directDate) return directDate.slice(0, 10);
  const created = timestampToIso(createdAt);
  return created?.slice(0, 10) || "Unavailable";
}

function mapStaffMember(id: string, data: Record<string, unknown>): StaffMember {
  const role: StaffRole = data.role === "Administrator" ? "Administrator" : "Operator";
  const legacyStatus = getString(data.status).toLowerCase();
  const passwordResetRequestedAt = timestampToIso(data.passwordResetRequestedAt);
  const passwordResetCompletedAt = timestampToIso(data.passwordResetCompletedAt);
  let inferredPasswordResetStatus: "idle" | "pending" | "completed" = "idle";
  if (passwordResetRequestedAt) inferredPasswordResetStatus = "pending";
  if (passwordResetCompletedAt) inferredPasswordResetStatus = "completed";

  return {
    id,
    uid: getString(data.uid) || undefined,
    authUid: getString(data.authUid) || undefined,
    role,
    username: getString(data.username),
    email: getString(data.email).toLowerCase(),
    dateJoined: getDateJoined(data.dateJoined, data.createdAt),
    emailVerified: data.emailVerified !== false && legacyStatus !== "pending",
    accountStatus: data.accountStatus === "archived" || legacyStatus === "archived" ? "archived" : "active",
    emailChangeStatus:
      data.emailChangeStatus === "pending" || data.emailChangeStatus === "completed" ? data.emailChangeStatus : "none",
    pendingEmail: getString(data.pendingEmail).toLowerCase() || undefined,
    previousEmail: getString(data.previousEmail).toLowerCase() || undefined,
    emailChangeCompletedAt: timestampToIso(data.emailChangeCompletedAt),
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

export function subscribeToStaffMembers(onData: (staff: StaffMember[]) => void, onError: (error: Error) => void) {
  if (!db) {
    onData([]);
    return () => undefined;
  }

  let staff: StaffMember[] = [];
  let invitations: StaffMember[] = [];
  const ready = new Set<string>();
  const publish = () => {
    if (ready.size < 2) return;
    onData([...invitations, ...staff].sort((left, right) => right.dateJoined.localeCompare(left.dateJoined)));
  };

  const staffUnsubscribe = onSnapshot(
    collection(db, "staff"),
    (snapshot) => {
      staff = snapshot.docs.map((document) => mapStaffMember(document.id, document.data()));
      ready.add("staff");
      publish();
    },
    onError,
  );
  const invitationUnsubscribe = onSnapshot(
    collection(db, "pendingStaffInvitations"),
    (snapshot) => {
      invitations = snapshot.docs
        .filter((document) => {
          const data = document.data();
          const expiresAt = timestampToIso(data.expiresAt);
          return data.status === "pending" && Boolean(expiresAt && Date.parse(expiresAt) > Date.now());
        })
        .map((document) => {
          const data = document.data();
          return {
            id: `invitation:${document.id}`,
            role: data.role === "Administrator" ? "Administrator" : "Operator",
            username: getString(data.username),
            email: getString(data.email).toLowerCase(),
            dateJoined: timestampToIso(data.createdAt)?.slice(0, 10) || "Pending",
            emailVerified: false,
            accountStatus: "active",
            emailChangeStatus: "none",
            isInvitation: true,
          } satisfies StaffMember;
        });
      ready.add("invitations");
      publish();
    },
    onError,
  );

  return () => {
    staffUnsubscribe();
    invitationUnsubscribe();
  };
}
