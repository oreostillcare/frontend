"use client";

import * as React from "react";

import { Archive, ArrowUpDown, KeyRound, Plus, RotateCcw, SquarePen } from "lucide-react";
import { toast } from "sonner";

import { PasswordResetDialog } from "@/components/password-reset-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";
import { createPendingVerifiedAccount } from "@/lib/firebase/auth-email";
import { staffApi } from "@/lib/firebase/staff-api";
import { subscribeToStaffMembers } from "@/lib/firebase/staff-service";

import { ArchiveStaffDialog } from "./delete-staff-dialog";
import { StaffDialog } from "./staff-dialog";
import type { StaffFormData, StaffMember, StaffSaveResult } from "./staff-types";

type SortField = "role" | "username" | "email" | "accountStatus" | "dateJoined";

interface PendingEmailVerification {
  message: string;
  email: string;
  verificationToken: string;
  temporaryPassword: string;
  expiresAt: string;
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

function getAccountStatus(staff: StaffMember) {
  if (staff.accountStatus === "archived") return "Verified Archived";
  if (!staff.emailVerified) return "Pending Verification";
  return "Verified Active";
}

export function StaffTable() {
  const { user, staffRole } = useFirebaseAccount();
  const [staffList, setStaffList] = React.useState<StaffMember[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sortField, setSortField] = React.useState<SortField>("dateJoined");
  const [sortDirection, setSortDirection] = React.useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = React.useState(1);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingStaff, setEditingStaff] = React.useState<StaffMember | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = React.useState(false);
  const [staffToArchive, setStaffToArchive] = React.useState<StaffMember | null>(null);
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
      .filter((staff) =>
        [staff.role, staff.username, staff.email, staff.pendingEmail || "", getAccountStatus(staff)]
          .join(" ")
          .toLowerCase()
          .includes(search),
      )
      .sort((left, right) => {
        const comparison = String(left[sortField] || "").localeCompare(String(right[sortField] || ""));
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [searchQuery, sortDirection, sortField, staffList]);

  const totalPages = Math.max(1, Math.ceil(filteredStaff.length / pageSize));
  const paginatedStaff = filteredStaff.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  React.useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const handleSaveStaff = async (formData: StaffFormData): Promise<StaffSaveResult> => {
    if (!isAdmin) return "saved";

    if (!editingStaff) {
      const result = await staffApi<PendingEmailVerification>("/api/staff/invitations", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      try {
        await createPendingVerifiedAccount(
          result.email,
          result.temporaryPassword,
          verificationUrl("/complete-invitation", result.verificationToken),
        );
      } catch (error) {
        await staffApi("/api/staff/invitations", {
          method: "DELETE",
          body: JSON.stringify({ token: result.verificationToken }),
        }).catch(() => undefined);
        throw error;
      }
      toast.success(`Firebase sent a verification email to ${result.email}.`);
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

  const handleArchiveConfirm = async () => {
    if (!isAdmin || !staffToArchive) return;
    const result = await staffApi<{ message: string }>(`/api/staff/${encodeURIComponent(staffToArchive.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "archive" }),
    });
    toast.success(result.message);
  };

  const handleReactivate = async (staff: StaffMember) => {
    try {
      const result = await staffApi<{ message: string }>(`/api/staff/${encodeURIComponent(staff.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "reactivate" }),
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to reactivate this account.");
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
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {isAdmin && (
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
              )}
            </div>
            <div className="flex items-center gap-2">
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
                      No staff records found matching your search.
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading &&
                  paginatedStaff.length > 0 &&
                  paginatedStaff.map((staff) => {
                    const status = getAccountStatus(staff);
                    const isOwnAccount =
                      staff.uid === user?.uid || staff.authUid === user?.uid || staff.email === user?.email;
                    return (
                      <TableRow key={staff.id} className="hover:bg-muted/40">
                        <TableCell>
                          <Badge variant={staff.role === "Administrator" ? "default" : "outline"}>{staff.role}</Badge>
                        </TableCell>
                        <TableCell className="font-medium text-foreground">{staff.username}</TableCell>
                        <TableCell className="max-w-[220px] text-muted-foreground">
                          <span className="block truncate">{staff.email}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={status === "Verified Active" ? "secondary" : "outline"}>{status}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{staff.dateJoined}</TableCell>
                        {isAdmin && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {staff.isInvitation && (
                                <span className="px-2 text-muted-foreground text-xs">Awaiting verification</span>
                              )}
                              {!staff.isInvitation && staff.accountStatus === "archived" && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => void handleReactivate(staff)}
                                  title="Reactivate staff account"
                                >
                                  <RotateCcw />
                                  <span className="sr-only">Reactivate {staff.username}</span>
                                </Button>
                              )}
                              {!staff.isInvitation && staff.accountStatus !== "archived" && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => {
                                      setStaffToReset(staff);
                                      setResetDialogOpen(true);
                                    }}
                                    title="Reset password"
                                  >
                                    <KeyRound />
                                    <span className="sr-only">Reset password for {staff.username}</span>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => {
                                      setEditingStaff(staff);
                                      setDialogOpen(true);
                                    }}
                                    title="Edit staff member"
                                  >
                                    <SquarePen />
                                    <span className="sr-only">Edit {staff.username}</span>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => {
                                      setStaffToArchive(staff);
                                      setArchiveDialogOpen(true);
                                    }}
                                    disabled={isOwnAccount}
                                    title={
                                      isOwnAccount ? "You cannot archive your own account" : "Archive staff member"
                                    }
                                  >
                                    <Archive />
                                    <span className="sr-only">Archive {staff.username}</span>
                                  </Button>
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
          <PasswordResetDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen} staff={staffToReset} />
        </>
      )}
    </div>
  );
}
