"use client";

import * as React from "react";

import {
  Archive,
  ArrowUpDown,
  CheckCircle2,
  CircleX,
  Clock3,
  KeyRound,
  type LucideIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  SquarePen,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PasswordResetDialog } from "@/components/password-reset-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";
import { createPendingVerifiedAccount } from "@/lib/firebase/auth-email";
import { staffApi } from "@/lib/firebase/staff-api";
import { subscribeToStaffMembers } from "@/lib/firebase/staff-service";
import { cn } from "@/lib/utils";

import { ArchiveStaffDialog, CancelInvitationDialog, RestoreStaffDialog } from "./delete-staff-dialog";
import { StaffDialog } from "./staff-dialog";
import type { StaffFormData, StaffMember, StaffSaveResult } from "./staff-types";

type SortField = "role" | "username" | "email" | "accountStatus" | "dateJoined";
type StatusFilter = "active" | "archived" | "all";

interface PendingEmailVerification {
  message: string;
  email: string;
  verificationToken: string;
  temporaryPassword: string;
  expiresAt: string;
}

interface InvitationCreatedResponse {
  success: boolean;
  message: string;
  email: string;
  expiresAt: string;
}

interface ResendVerificationResponse {
  success: boolean;
  message: string;
  expiresAt: string;
  cooldownEndsAt: string;
}

interface CancelEmailVerificationResponse {
  message: string;
  status: "cancelled" | "completed" | "idle";
}

function verificationUrl(pathname: string, token: string) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set("token", token);
  return url.toString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MS = 6 * DAY_MS;

interface StaffStatus {
  label: string;
  icon: LucideIcon;
  variant: React.ComponentProps<typeof Badge>["variant"];
}

function timestampMillis(value?: string) {
  if (!value) return 0;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? 0 : milliseconds;
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function invitationExpiryMillis(staff: StaffMember) {
  if (staff.invitationStatus === "expired") return 0;
  const storedExpiry = timestampMillis(staff.invitationExpiresAt);
  const sentAt = timestampMillis(staff.verificationSentAt);
  const oneHourExpiry = sentAt ? sentAt + 60 * 60 * 1000 : 0;
  if (storedExpiry && oneHourExpiry) return Math.min(storedExpiry, oneHourExpiry);
  return storedExpiry || oneHourExpiry;
}

function archivedUnverifiedStatus(staff: StaffMember, now: number): StaffStatus {
  const archivedAt = timestampMillis(staff.archivedAt);
  const remaining = archivedAt ? archivedAt + ARCHIVE_RETENTION_MS - now : 0;
  if (remaining <= 0) return { label: "Archived · deletion pending", icon: TriangleAlert, variant: "destructive" };

  const days = Math.ceil(remaining / DAY_MS);
  if (days === 1) return { label: "Archived · deletes tomorrow", icon: TriangleAlert, variant: "destructive" };
  return {
    label: `Archived · deletes in ${days} days`,
    icon: days <= 3 ? TriangleAlert : Archive,
    variant: days <= 3 ? "destructive" : "outline",
  };
}

function getAccountStatus(staff: StaffMember, now: number): StaffStatus {
  if (staff.accountStatus === "archived") {
    if (!staff.emailVerified) return archivedUnverifiedStatus(staff, now);
    return { label: "Archived", icon: Archive, variant: "outline" };
  }
  if (staff.isInvitation || !staff.emailVerified) {
    const remaining = invitationExpiryMillis(staff) - now;
    if (remaining <= 0) return { label: "Verification expired", icon: CircleX, variant: "destructive" };
    return { label: `${formatCountdown(remaining)} remaining`, icon: Clock3, variant: "outline" };
  }
  return { label: "Verified Active", icon: CheckCircle2, variant: "secondary" };
}

interface ActionIconButtonProps extends Omit<React.ComponentProps<typeof Button>, "children"> {
  label: string;
  children: React.ReactNode;
}

function ActionIconButton({ label, children, ...buttonProps }: ActionIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...buttonProps}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function StaffTable() {
  const { user, staffRole } = useFirebaseAccount();
  const [staffList, setStaffList] = React.useState<StaffMember[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sortField, setSortField] = React.useState<SortField>("dateJoined");
  const [sortDirection, setSortDirection] = React.useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("active");
  const [now, setNow] = React.useState(() => Date.now());
  const [resendingEmail, setResendingEmail] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingStaff, setEditingStaff] = React.useState<StaffMember | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = React.useState(false);
  const [staffToArchive, setStaffToArchive] = React.useState<StaffMember | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = React.useState(false);
  const [staffToRestore, setStaffToRestore] = React.useState<StaffMember | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = React.useState(false);
  const [invitationToCancel, setInvitationToCancel] = React.useState<StaffMember | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);
  const [staffToReset, setStaffToReset] = React.useState<StaffMember | null>(null);

  const pageSize = 5;
  const isAdmin = staffRole === "Administrator";

  React.useEffect(
    () =>
      subscribeToStaffMembers(
        (staff) => {
          setStaffList(staff);
          setIsLoading(false);
        },
        (error) => {
          console.error("Staff subscription error:", error);
          toast.error("Failed to subscribe to staff records in Firestore.");
          setIsLoading(false);
        },
      ),
    [],
  );

  const hasInvitationRows = staffList.some((staff) => staff.isInvitation);
  React.useEffect(() => {
    if (!hasInvitationRows) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasInvitationRows]);

  const pendingCredentialKey = staffList
    .filter(
      (staff) =>
        !staff.isInvitation && (staff.emailChangeStatus === "pending" || staff.passwordResetStatus === "pending"),
    )
    .map((staff) => `${staff.id}:${staff.emailChangeStatus}:${staff.passwordResetStatus}`)
    .join("|");

  React.useEffect(() => {
    if (!isAdmin || !pendingCredentialKey) return;
    const pendingStaff = staffList.filter(
      (staff) =>
        !staff.isInvitation && (staff.emailChangeStatus === "pending" || staff.passwordResetStatus === "pending"),
    );
    const reconcileCredentialUpdates = async () => {
      await Promise.all(
        pendingStaff.flatMap((staff) => {
          const checks: Promise<void>[] = [];
          if (staff.emailChangeStatus === "pending") {
            checks.push(
              staffApi(`/api/staff/${encodeURIComponent(staff.id)}/email-change`)
                .then(() => undefined)
                .catch((error: unknown) => console.error("Email change status error:", error)),
            );
          }
          if (staff.passwordResetStatus === "pending") {
            checks.push(
              staffApi(`/api/staff/password-reset?staffId=${encodeURIComponent(staff.id)}`)
                .then(() => undefined)
                .catch((error: unknown) => console.error("Password reset status error:", error)),
            );
          }
          return checks;
        }),
      );
    };

    void reconcileCredentialUpdates();
    const interval = window.setInterval(() => void reconcileCredentialUpdates(), 3000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isAdmin, pendingCredentialKey, staffList]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDirection("asc");
    }
    setCurrentPage(1);
  };

  const filteredStaff = React.useMemo(() => {
    const search = searchQuery.toLowerCase().trim();
    return staffList
      .filter((staff) => {
        if (statusFilter === "active") return staff.accountStatus !== "archived";
        if (statusFilter === "archived") return staff.accountStatus === "archived";
        return true;
      })
      .filter((staff) =>
        [staff.role, staff.username, staff.email, staff.pendingEmail || "", getAccountStatus(staff, now).label]
          .join(" ")
          .toLowerCase()
          .includes(search),
      )
      .sort((left, right) => {
        const comparison = String(left[sortField] || "").localeCompare(String(right[sortField] || ""));
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [now, searchQuery, sortDirection, sortField, staffList, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredStaff.length / pageSize));
  const paginatedStaff = filteredStaff.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  React.useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const handleSaveStaff = async (formData: StaffFormData): Promise<StaffSaveResult> => {
    if (!isAdmin) return "saved";

    if (!editingStaff) {
      const result = await staffApi<InvitationCreatedResponse>("/api/staff/invitations", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      toast.success(result.message);
      return "saved";
    }

    await staffApi<{ message: string }>(`/api/staff/${encodeURIComponent(editingStaff.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "update", username: formData.username, role: formData.role }),
    });

    if (formData.email !== editingStaff.email.toLowerCase()) {
      const result = await staffApi<PendingEmailVerification>(
        `/api/staff/${encodeURIComponent(editingStaff.id)}/email-change`,
        { method: "POST", body: JSON.stringify({ email: formData.email }) },
      );
      try {
        await createPendingVerifiedAccount(
          result.email,
          result.temporaryPassword,
          verificationUrl("/verify-email-change", result.verificationToken),
        );
      } catch (error) {
        await staffApi(`/api/staff/${encodeURIComponent(editingStaff.id)}/email-change`, {
          method: "DELETE",
        }).catch(() => undefined);
        throw error;
      }
      toast.success(`Firebase sent a verification email to ${result.email}.`);
      return "verification-pending";
    }
    toast.success(`Updated account for ${formData.username}.`);
    return "saved";
  };

  const validateNewEmail = (email: string) => {
    const existing = staffList.find(
      (staff) => staff.id !== editingStaff?.id && staff.email.toLowerCase() === email.toLowerCase(),
    );
    if (!existing) return null;
    return existing.accountStatus === "archived"
      ? "This email belongs to an archived account. Reactivate that account instead."
      : "A staff account already uses this email address.";
  };

  const actionErrorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

  const handleArchiveConfirm = async () => {
    if (!isAdmin || !staffToArchive) return;
    try {
      const result = await staffApi<{ message: string }>("/api/staff/archive", {
        method: "POST",
        body: JSON.stringify({ staffId: staffToArchive.id }),
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Unable to archive this account."));
      throw error;
    }
  };

  const handleRestoreConfirm = async () => {
    if (!isAdmin || !staffToRestore) return;
    try {
      const result = await staffApi<{ message: string }>("/api/staff/restore", {
        method: "POST",
        body: JSON.stringify({ staffId: staffToRestore.id }),
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Unable to restore this account."));
      throw error;
    }
  };

  const handleResendVerification = async (staff: StaffMember) => {
    if (!isAdmin || resendingEmail) return;
    try {
      setResendingEmail(staff.email);
      const result = await staffApi<ResendVerificationResponse>("/api/staff/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: staff.email }),
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Unable to resend the verification email."));
    } finally {
      setResendingEmail(null);
    }
  };

  const handleCancelInvitation = async () => {
    if (!isAdmin || !invitationToCancel) return;
    try {
      const result = await staffApi<{ message: string }>("/api/staff/invitations", {
        method: "DELETE",
        body: JSON.stringify({ invitationId: invitationToCancel.id }),
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Unable to cancel this invitation."));
      throw error;
    }
  };

  const handleCancelEmailVerification = async () => {
    if (!editingStaff) return;
    const result = await staffApi<CancelEmailVerificationResponse>(
      `/api/staff/${encodeURIComponent(editingStaff.id)}/email-change`,
      { method: "DELETE" },
    );
    toast.success(result.message);
  };

  const activeEditingStaff = editingStaff
    ? (staffList.find((staff) => staff.id === editingStaff.id) ?? editingStaff)
    : null;

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "archived", label: "Archived" },
    { key: "all", label: "All" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-bold text-2xl text-foreground tracking-tight md:text-3xl">Staff Information</h1>
        <p className="text-muted-foreground text-sm">
          Manage verified administrator and operator accounts connected to Firebase.
        </p>
      </div>

      <Card className="rounded-xl border shadow-xs">
        <CardContent className="p-4 md:p-6">
          <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            {isAdmin && statusFilter !== "archived" && (
              <div className="flex items-center sm:col-start-1 sm:row-start-1">
                <Button
                  onClick={() => {
                    setEditingStaff(null);
                    setDialogOpen(true);
                  }}
                  className="h-9 gap-1.5 font-medium"
                >
                  <Plus data-icon="inline-start" />
                  Add staff
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 sm:col-start-2 sm:row-start-1 sm:justify-self-center">
              <label htmlFor="staff-search-input" className="font-medium text-foreground text-sm">
                Search:
              </label>
              <Input
                id="staff-search-input"
                placeholder="Search staff..."
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-8 w-44 md:w-56"
              />
            </div>

            <div className="flex items-center sm:col-start-3 sm:row-start-1 sm:justify-self-end">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={statusFilter}
                onValueChange={(value) => {
                  if (value) {
                    setStatusFilter(value as StatusFilter);
                    setCurrentPage(1);
                  }
                }}
                aria-label="Filter staff by account status"
              >
                {filterTabs.map((tab) => (
                  <ToggleGroupItem key={tab.key} value={tab.key} aria-label={`Show ${tab.label.toLowerCase()} staff`}>
                    {tab.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {[
                    ["role", "Role"],
                    ["username", "Username"],
                    ["email", "Email"],
                    ["accountStatus", "Account Status"],
                    ["dateJoined", "Date Joined"],
                  ].map(([field, label]) => (
                    <TableHead
                      key={field}
                      onClick={() => handleSort(field as SortField)}
                      className="cursor-pointer select-none font-semibold text-foreground"
                    >
                      <div className="flex items-center gap-1.5">
                        {label}
                        <ArrowUpDown className="size-3.5 text-muted-foreground" />
                      </div>
                    </TableHead>
                  ))}
                  {isAdmin && <TableHead className="text-right font-semibold text-foreground">Actions</TableHead>}
                </TableRow>
              </TableHeader>

              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground text-sm">
                      Loading staff records...
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && paginatedStaff.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground text-sm">
                      {statusFilter === "archived"
                        ? "No archived staff accounts."
                        : "No staff records found matching your search."}
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading &&
                  paginatedStaff.length > 0 &&
                  paginatedStaff.map((staff) => {
                    const status = getAccountStatus(staff, now);
                    const StatusIcon = status.icon;
                    const isArchived = staff.accountStatus === "archived";
                    const isInvitationExpired = Boolean(staff.isInvitation) && invitationExpiryMillis(staff) <= now;
                    const isActiveInvitation = Boolean(staff.isInvitation) && !isArchived && !isInvitationExpired;
                    const isExpiredInvitation = Boolean(staff.isInvitation) && !isArchived && isInvitationExpired;
                    const isResending = resendingEmail === staff.email;
                    const isVerificationSending =
                      isResending ||
                      (staff.verificationDeliveryStatus === "sending" &&
                        !isInvitationExpired &&
                        now - timestampMillis(staff.verificationSentAt) < 30_000);
                    const resendCooldownRemaining = timestampMillis(staff.verificationResendAvailableAt) - now;
                    const isResendCoolingDown = resendCooldownRemaining > 0;
                    let resendVerificationLabel = `Resend verification to ${staff.email}`;
                    if (isResending) {
                      resendVerificationLabel = "Resending verification email";
                    } else if (isResendCoolingDown) {
                      resendVerificationLabel = `Resend available in ${formatCountdown(resendCooldownRemaining)}`;
                    }
                    const isOwnAccount =
                      staff.uid === user?.uid || staff.authUid === user?.uid || staff.email === user?.email;

                    return (
                      <TableRow key={staff.id} className={cn("hover:bg-muted/40", isArchived && "opacity-70")}>
                        <TableCell>
                          <Badge variant={staff.role === "Administrator" ? "default" : "outline"}>{staff.role}</Badge>
                        </TableCell>
                        <TableCell className="font-medium text-foreground">{staff.username}</TableCell>
                        <TableCell className="max-w-[220px] text-muted-foreground">
                          <span className="block truncate">{staff.email}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={status.variant}>
                            <StatusIcon />
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{staff.dateJoined}</TableCell>

                        {isAdmin && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {isArchived && (
                                <ActionIconButton
                                  label={`Restore ${staff.username}`}
                                  onClick={() => {
                                    setStaffToRestore(staff);
                                    setRestoreDialogOpen(true);
                                  }}
                                >
                                  <RotateCcw />
                                </ActionIconButton>
                              )}

                              {isActiveInvitation && isVerificationSending && (
                                <ActionIconButton label="Sending verification email" disabled>
                                  <Spinner />
                                </ActionIconButton>
                              )}

                              {isActiveInvitation && !isVerificationSending && (
                                <ActionIconButton
                                  label={`Cancel invitation for ${staff.username}`}
                                  onClick={() => {
                                    setInvitationToCancel(staff);
                                    setCancelDialogOpen(true);
                                  }}
                                >
                                  <X />
                                </ActionIconButton>
                              )}

                              {isExpiredInvitation && (
                                <ActionIconButton
                                  label={resendVerificationLabel}
                                  onClick={() => void handleResendVerification(staff)}
                                  disabled={Boolean(resendingEmail) || isResendCoolingDown}
                                >
                                  {isResending ? <Spinner /> : <RefreshCw />}
                                </ActionIconButton>
                              )}

                              {staff.isInvitation && !isArchived && (
                                <ActionIconButton
                                  label={`Archive ${staff.username}`}
                                  onClick={() => {
                                    setStaffToArchive(staff);
                                    setArchiveDialogOpen(true);
                                  }}
                                  disabled={isVerificationSending}
                                >
                                  <Archive />
                                </ActionIconButton>
                              )}

                              {!staff.isInvitation && !isArchived && (
                                <>
                                  <ActionIconButton
                                    label={`Reset password for ${staff.username}`}
                                    onClick={() => {
                                      setStaffToReset(staff);
                                      setResetDialogOpen(true);
                                    }}
                                  >
                                    <KeyRound />
                                  </ActionIconButton>
                                  <ActionIconButton
                                    label={`Edit ${staff.username}`}
                                    onClick={() => {
                                      setEditingStaff(staff);
                                      setDialogOpen(true);
                                    }}
                                  >
                                    <SquarePen />
                                  </ActionIconButton>
                                  <ActionIconButton
                                    label={
                                      isOwnAccount ? "You cannot archive your own account" : `Archive ${staff.username}`
                                    }
                                    onClick={() => {
                                      setStaffToArchive(staff);
                                      setArchiveDialogOpen(true);
                                    }}
                                    disabled={isOwnAccount}
                                  >
                                    <Archive />
                                  </ActionIconButton>
                                </>
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex items-center justify-end gap-1 text-muted-foreground text-sm">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage <= 1}
              className="h-8 px-3 text-xs"
            >
              Previous
            </Button>
            {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
              <Button
                key={page}
                variant={currentPage === page ? "default" : "outline"}
                size="sm"
                onClick={() => setCurrentPage(page)}
                className="h-8 min-w-8 px-2 text-xs"
              >
                {page}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage >= totalPages}
              className="h-8 px-3 text-xs"
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <StaffDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            staffToEdit={activeEditingStaff}
            onSave={handleSaveStaff}
            onCancelVerification={handleCancelEmailVerification}
            validateNewEmail={validateNewEmail}
          />
          <ArchiveStaffDialog
            open={archiveDialogOpen}
            onOpenChange={setArchiveDialogOpen}
            staff={staffToArchive}
            onConfirmArchive={handleArchiveConfirm}
          />
          <RestoreStaffDialog
            open={restoreDialogOpen}
            onOpenChange={setRestoreDialogOpen}
            staff={staffToRestore}
            onConfirmRestore={handleRestoreConfirm}
          />
          <CancelInvitationDialog
            open={cancelDialogOpen}
            onOpenChange={setCancelDialogOpen}
            staff={invitationToCancel}
            onConfirmCancel={handleCancelInvitation}
          />
          <PasswordResetDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen} staff={staffToReset} />
        </>
      )}
    </div>
  );
}
