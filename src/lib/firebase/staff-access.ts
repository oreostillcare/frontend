import type { User } from "firebase/auth";
import { collection, getDocs, limit, type QueryConstraint, query, where } from "firebase/firestore";

import { db } from "./client";

export type StaffRole = "Administrator" | "Operator";

export interface StaffProfile {
  username: string;
  email: string;
  role: StaffRole;
  dateJoined?: string;
}

export interface StaffAccess {
  profile: StaffProfile | null;
  administratorEmail: string | null;
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRole(value: unknown): StaffRole | null {
  const role = getString(value).toLowerCase();

  if (role === "administrator" || role === "admin") {
    return "Administrator";
  }

  if (role === "operator") {
    return "Operator";
  }

  return null;
}

async function findCurrentStaff(user: User): Promise<StaffProfile | null> {
  if (!db || !user.email) {
    return null;
  }

  const staffRef = collection(db, "staff");
  const email = user.email.trim();
  const normalizedEmail = email.toLowerCase();
  const emailCandidates = [...new Set([email, normalizedEmail])];
  const lookups: QueryConstraint[][] = [
    [where("email", "in", emailCandidates), limit(1)],
    [where("normalizedEmail", "==", normalizedEmail), limit(1)],
    [where("emailNormalized", "==", normalizedEmail), limit(1)],
    [where("authUid", "==", user.uid), limit(1)],
    [where("uid", "==", user.uid), limit(1)],
  ];

  const results = await Promise.allSettled(lookups.map((constraints) => getDocs(query(staffRef, ...constraints))));
  const match = results.find((result) => result.status === "fulfilled" && !result.value.empty);

  if (match?.status !== "fulfilled") {
    return null;
  }

  const data = match.value.docs[0]?.data();
  if (!data) {
    return null;
  }
  const role = normalizeRole(data.role);

  if (!role) {
    return null;
  }

  return {
    username: getString(data.username) || user.displayName?.trim() || email.split("@")[0],
    email: getString(data.email) || email,
    role,
    dateJoined: getString(data.dateJoined) || undefined,
  };
}

async function findAdministratorEmail(currentProfile: StaffProfile | null): Promise<string | null> {
  if (currentProfile?.role === "Administrator") {
    return currentProfile.email;
  }

  if (!db) {
    return null;
  }

  const staffRef = collection(db, "staff");
  const lookups: QueryConstraint[][] = [
    [where("role", "in", ["Administrator", "administrator", "Admin", "admin"]), limit(20)],
    [where("isAdministrator", "==", true), limit(20)],
  ];
  const results = await Promise.allSettled(lookups.map((constraints) => getDocs(query(staffRef, ...constraints))));
  const emails = results.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }

    return result.value.docs.map((document) => getString(document.data().email).toLowerCase()).filter(Boolean);
  });

  return [...new Set(emails)].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

export async function loadStaffAccess(user: User): Promise<StaffAccess> {
  const profile = await findCurrentStaff(user);
  const administratorEmail = await findAdministratorEmail(profile);

  return { profile, administratorEmail };
}
