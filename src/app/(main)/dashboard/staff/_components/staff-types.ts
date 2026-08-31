export type StaffRole = "Administrator" | "Operator";

export interface StaffMember {
  id: string;
  uid?: string;
  authUid?: string;
  role: StaffRole;
  username: string;
  email: string;
  dateJoined: string;
  emailVerified: boolean;
  accountStatus: "active" | "archived";
  archivedAt?: string;
  emailChangeStatus: "none" | "pending" | "completed";
  pendingEmail?: string;
  previousEmail?: string;
  emailChangeCompletedAt?: string;
  isInvitation?: boolean;
  invitationStatus?: "pending" | "expired";
  invitationExpiresAt?: string;
  verificationSentAt?: string;
  verificationResendAvailableAt?: string;
  verificationDeliveryStatus?: "sending" | "sent" | "failed";
  passwordResetStatus?: "idle" | "pending" | "completed" | "failed";
  passwordResetRequestedAt?: string;
  passwordResetCompletedAt?: string;
}

export type StaffFormData = Pick<StaffMember, "role" | "username" | "email">;
export type StaffSaveResult = "saved" | "verification-pending";
