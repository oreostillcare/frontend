import "server-only";

import type { DecodedIdToken } from "firebase-admin/auth";
import { type DocumentSnapshot, Timestamp } from "firebase-admin/firestore";

import { adminAuth, adminDb } from "./admin";
import { createHash, randomBytes } from "node:crypto";

export type StaffRole = "Administrator" | "Operator";

export interface AuthenticatedStaff {
  token: DecodedIdToken;
  documentId: string;
  role: StaffRole;
  email: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad-request",
  ) {
    super(message);
  }
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

export function getRequestOrigin(request: Request) {
  return process.env.APP_BASE_URL || new URL(request.url).origin;
}

export async function authenticateStaff(request: Request): Promise<AuthenticatedStaff> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError("Authentication required.", 401, "unauthenticated");
  }

  const token = await adminAuth.verifyIdToken(authorization.slice(7));
  const directDocument = await adminDb.collection("staff").doc(token.uid).get();
  const staffByUid = directDocument.exists
    ? null
    : await adminDb.collection("staff").where("uid", "==", token.uid).limit(1).get();
  const uidDocument = directDocument.exists ? directDocument : staffByUid?.docs[0];
  const legacyByUid = uidDocument
    ? null
    : await adminDb.collection("staff").where("authUid", "==", token.uid).limit(1).get();
  const email = token.email?.trim().toLowerCase();
  const emailSnapshot =
    !uidDocument && legacyByUid?.empty && email
      ? await adminDb.collection("staff").where("normalizedEmail", "==", email).limit(1).get()
      : null;
  const exactEmailSnapshot =
    !uidDocument && legacyByUid?.empty && emailSnapshot?.empty && email
      ? await adminDb.collection("staff").where("email", "==", email).limit(1).get()
      : null;
  const document = uidDocument ?? legacyByUid?.docs[0] ?? emailSnapshot?.docs[0] ?? exactEmailSnapshot?.docs[0];
  const data = document?.data();

  if (!document || !data || data.accountStatus === "archived" || data.status === "archived") {
    throw new ApiError("This staff account is not active.", 403, "inactive-account");
  }

  let role: StaffRole | null = null;
  if (data.role === "Administrator") role = "Administrator";
  if (data.role === "Operator") role = "Operator";
  if (!role) {
    throw new ApiError("Staff role is unavailable.", 403, "missing-role");
  }

  return {
    token,
    documentId: document.id,
    role,
    email: String(data.email || email || "").toLowerCase(),
  };
}

export async function requireAdministrator(request: Request) {
  const staff = await authenticateStaff(request);
  if (staff.role !== "Administrator") {
    throw new ApiError("Administrator access is required.", 403, "administrator-required");
  }
  return staff;
}

export async function findStaffDocument(id: string) {
  const directDocument = await adminDb.collection("staff").doc(id).get();
  if (directDocument.exists) return directDocument;

  const uidMatch = await adminDb.collection("staff").where("uid", "==", id).limit(1).get();
  if (!uidMatch.empty) return uidMatch.docs[0];

  const legacyUidMatch = await adminDb.collection("staff").where("authUid", "==", id).limit(1).get();
  return legacyUidMatch.docs[0] ?? null;
}

export async function findStaffByEmail(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedMatch = await adminDb
    .collection("staff")
    .where("normalizedEmail", "==", normalizedEmail)
    .limit(1)
    .get();
  if (!normalizedMatch.empty) return normalizedMatch.docs[0];

  const exactMatch = await adminDb.collection("staff").where("email", "==", normalizedEmail).limit(1).get();
  return exactMatch.docs[0] ?? null;
}

export async function getStaffAuthUid(document: DocumentSnapshot) {
  const data = document.data();
  if (typeof data?.uid === "string" && data.uid) return data.uid;
  if (typeof data?.authUid === "string" && data.authUid) return data.authUid;

  const email = typeof data?.email === "string" ? normalizeEmail(data.email) : "";
  if (!email) {
    throw new ApiError("This staff record is not connected to Firebase Authentication.", 409, "missing-auth-user");
  }

  try {
    const user = await adminAuth.getUserByEmail(email);
    return user.uid;
  } catch {
    throw new ApiError("This staff record is not connected to Firebase Authentication.", 409, "missing-auth-user");
  }
}

export function expiresInHours(hours: number) {
  return Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000);
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }

  const code = (error as { code?: string }).code;
  if (code === "auth/email-already-exists" || code === "auth/email-already-in-use") {
    return Response.json(
      { error: "A Firebase Authentication account already uses this email address.", code },
      { status: 409 },
    );
  }
  if (code === "auth/user-not-found") {
    return Response.json({ error: "The Firebase Authentication user was not found.", code }, { status: 404 });
  }
  if (code === "auth/invalid-password") {
    return Response.json({ error: "The password does not meet Firebase requirements.", code }, { status: 400 });
  }

  const message = error instanceof Error ? error.message : "";
  if (message.includes("Could not load the default credentials")) {
    return Response.json(
      {
        error:
          "Firebase Admin is not configured on this server. Add a service-account credential and restart SmartRoad.",
        code: "firebase-admin-not-configured",
      },
      { status: 503 },
    );
  }

  console.error("SmartRoad staff API error:", error);
  return Response.json({ error: "An unexpected server error occurred.", code: "internal" }, { status: 500 });
}
