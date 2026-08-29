"use client";

import * as React from "react";

import { CircleHelp, KeyRound, LogOut } from "lucide-react";

import { PasswordResetDialog } from "@/components/password-reset-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";
import type { StaffRole } from "@/lib/firebase/staff-access";

function getRoleDescription(role: StaffRole | null) {
  if (role === "Operator") {
    return "Live view and monitoring access";
  }

  if (role === "Administrator") {
    return "Full staff management and settings access";
  }

  return "Staff role unavailable";
}

export function AccountPanel() {
  const { user, name, email, logout, isLoggingOut, staffProfile, staffRole, staffLoading, administratorEmail } =
    useFirebaseAccount();
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);

  const dateJoined =
    staffProfile?.dateJoined ||
    (user?.metadata.creationTime ? new Date(user.metadata.creationTime).toISOString().split("T")[0] : "Unavailable");

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Authenticated monitoring user</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-sm">Role</dt>
              <dd className="flex flex-col items-start gap-1">
                {staffLoading ? (
                  <span className="font-medium">Loading...</span>
                ) : (
                  <>
                    <Badge variant={staffRole === "Administrator" ? "default" : "outline"}>
                      {staffRole ?? "Unavailable"}
                    </Badge>
                    <span className="text-muted-foreground text-xs">{getRoleDescription(staffRole)}</span>
                  </>
                )}
              </dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-sm">Username</dt>
              <dd className="font-medium">{staffLoading ? "Loading..." : name}</dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-sm">Email</dt>
              <dd className="break-all font-medium">{staffLoading ? "Loading..." : email}</dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-sm">Date joined</dt>
              <dd className="font-medium">{staffLoading ? "Loading..." : dateJoined}</dd>
            </div>
          </dl>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setResetDialogOpen(true)} disabled={!user?.email || !staffProfile}>
            <KeyRound data-icon="inline-start" />
            Reset password
          </Button>
          <Button variant="outline" onClick={() => void logout()} disabled={!user || isLoggingOut}>
            <LogOut data-icon="inline-start" />
            {isLoggingOut ? "Logging out..." : "Log out"}
          </Button>
        </CardFooter>
      </Card>

      {!staffLoading && staffRole === "Operator" && (
        <Alert>
          <CircleHelp />
          <AlertTitle>Need help with your account?</AlertTitle>
          <AlertDescription>
            If a problem persists, contact the administrator
            {administratorEmail ? (
              <>
                {" "}
                at <a href={`mailto:${administratorEmail}`}>{administratorEmail}</a>.
              </>
            ) : (
              ". Administrator email is currently unavailable."
            )}
          </AlertDescription>
        </Alert>
      )}

      <PasswordResetDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        staff={
          staffProfile
            ? {
                id: staffProfile.id,
                username: staffProfile.username,
                email: staffProfile.email,
                accountStatus: staffProfile.accountStatus,
                passwordResetStatus: staffProfile.passwordResetStatus,
                passwordResetRequestedAt: staffProfile.passwordResetRequestedAt,
                passwordResetCompletedAt: staffProfile.passwordResetCompletedAt,
              }
            : null
        }
      />
    </div>
  );
}
