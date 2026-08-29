"use client";

import * as React from "react";

import { CheckCircle2, KeyRound } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getFirebaseEmailError, sendNativePasswordReset } from "@/lib/firebase/auth-email";
import { StaffApiError, staffApi } from "@/lib/firebase/staff-api";

interface PasswordResetTarget {
  id: string;
  username: string;
  email: string;
  accountStatus?: "active" | "archived";
  passwordResetStatus?: "idle" | "pending" | "completed" | "failed";
  passwordResetRequestedAt?: string;
  passwordResetCompletedAt?: string;
}

interface PasswordResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: PasswordResetTarget | null;
}

const COOLDOWN_SECONDS = 180;

function getCooldownEnd(requestedAt?: string) {
  const milliseconds = requestedAt ? Date.parse(requestedAt) : 0;
  return Number.isNaN(milliseconds) || !milliseconds ? 0 : milliseconds + COOLDOWN_SECONDS * 1000;
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PasswordResetDialog({ open, onOpenChange, staff }: PasswordResetDialogProps) {
  const [isSending, setIsSending] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [cooldownEnd, setCooldownEnd] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  const [resetStatus, setResetStatus] = React.useState<"idle" | "pending" | "completed" | "failed">("idle");

  React.useEffect(() => {
    if (!open) return;
    setMessage(
      staff?.passwordResetStatus === "completed"
        ? "Firebase confirmed that this account's password was changed successfully."
        : "",
    );
    setError("");
    setResetStatus(staff?.passwordResetStatus ?? "idle");
    setCooldownEnd(getCooldownEnd(staff?.passwordResetRequestedAt));
    setNow(Date.now());
  }, [open, staff?.passwordResetRequestedAt, staff?.passwordResetStatus]);

  React.useEffect(() => {
    if (!open || cooldownEnd <= Date.now()) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [cooldownEnd, open]);

  React.useEffect(() => {
    if (!open || !staff || resetStatus !== "pending") return;
    let cancelled = false;

    const checkStatus = async () => {
      try {
        const result = await staffApi<{ status: "idle" | "pending" | "completed"; completedAt?: string }>(
          `/api/staff/password-reset?staffId=${encodeURIComponent(staff.id)}`,
        );
        if (cancelled || result.status !== "completed") return;
        setResetStatus("completed");
        setMessage("Firebase confirmed that this account's password was changed successfully.");
        setError("");
      } catch (caughtError) {
        if (!cancelled) console.error("Password reset status error:", caughtError);
      }
    };

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, resetStatus, staff]);

  const remainingSeconds = Math.max(0, Math.ceil((cooldownEnd - now) / 1000));
  const isArchived = staff?.accountStatus === "archived";

  const sendReset = async () => {
    if (!staff || isArchived) return;
    let resetPrepared = false;
    try {
      setIsSending(true);
      setError("");
      setMessage("");
      const result = await staffApi<{ message: string; cooldownEndsAt: string }>("/api/staff/password-reset", {
        method: "POST",
        body: JSON.stringify({ staffId: staff.id }),
      });
      resetPrepared = true;
      await sendNativePasswordReset(staff.email);
      setResetStatus("pending");
      setMessage(`Firebase sent the reset link to ${staff.email}. This status will update after the password changes.`);
      setCooldownEnd(Date.parse(result.cooldownEndsAt));
      setNow(Date.now());
    } catch (caughtError) {
      if (resetPrepared) {
        await staffApi("/api/staff/password-reset", {
          method: "DELETE",
          body: JSON.stringify({ staffId: staff.id }),
        }).catch(() => undefined);
      }
      if (caughtError instanceof StaffApiError && caughtError.cooldownEndsAt) {
        setCooldownEnd(Date.parse(caughtError.cooldownEndsAt));
        setNow(Date.now());
      }
      setResetStatus("failed");
      setError(getFirebaseEmailError(caughtError));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Send a secure, single-use password reset link to {staff?.email ?? "this staff account"}.
          </DialogDescription>
        </DialogHeader>

        {message && resetStatus === "pending" && (
          <Alert>
            <Spinner />
            <AlertTitle>Waiting for password change</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {message && resetStatus === "completed" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Password reset successful</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Unable to send reset link</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {isArchived && (
          <Alert variant="destructive">
            <AlertTitle>Account is archived</AlertTitle>
            <AlertDescription>Reactivate this staff account before sending a password reset link.</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSending}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => void sendReset()}
            disabled={isSending || isArchived || remainingSeconds > 0}
          >
            {isSending ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
            {remainingSeconds > 0 ? `Resend in ${formatCountdown(remainingSeconds)}` : "Send reset link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
