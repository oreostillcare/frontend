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

type ResetStatus = "idle" | "active" | "cancelled" | "completed" | "error";

const COOLDOWN_SECONDS = 180;

function getCooldownEnd(requestedAt?: string) {
  const milliseconds = requestedAt ? Date.parse(requestedAt) : 0;
  return Number.isNaN(milliseconds) || !milliseconds ? 0 : milliseconds + COOLDOWN_SECONDS * 1000;
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function readResetResponse(response: Response) {
  const payload = (await response.json()) as {
    status?: "active" | "cancelled" | "completed";
    requestId?: string;
    cooldownEndsAt?: string;
    error?: string;
  };
  if (!response.ok) {
    const error = new Error(payload.error ?? "The SmartRoad password reset request failed.") as Error & {
      cooldownEndsAt?: string;
      status?: number;
    };
    error.cooldownEndsAt = payload.cooldownEndsAt;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function PasswordResetDialog({ open, onOpenChange, staff }: PasswordResetDialogProps) {
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [cooldownEnd, setCooldownEnd] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  const [requestId, setRequestId] = React.useState("");
  const [resetStatus, setResetStatus] = React.useState<ResetStatus>("idle");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset dialog state when the selected staff member changes.
  React.useEffect(() => {
    setMessage("");
    setError("");
    setRequestId("");
    setResetStatus("idle");
    setNow(Date.now());
  }, [staff?.id]);

  React.useEffect(() => {
    setCooldownEnd(getCooldownEnd(staff?.passwordResetRequestedAt));
    setNow(Date.now());
  }, [staff?.passwordResetRequestedAt]);

  React.useEffect(() => {
    if (!open || cooldownEnd <= Date.now()) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [cooldownEnd, open]);

  React.useEffect(() => {
    if (!open || resetStatus !== "active" || !requestId) return;
    let cancelled = false;

    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/auth/password-reset?requestId=${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        });
        const result = await readResetResponse(response);
        if (cancelled || result.status !== "completed") return;
        setResetStatus("completed");
        setMessage("Firebase confirmed that this account's password was changed successfully.");
        setError("");
      } catch (caughtError) {
        if (cancelled) return;
        if ((caughtError as { status?: number }).status === 410) {
          setResetStatus("cancelled");
          setMessage(caughtError instanceof Error ? caughtError.message : "Password reset request cancelled.");
          setError("");
          return;
        }
        console.error("Password reset status error:", caughtError);
      }
    };

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, requestId, resetStatus]);

  React.useEffect(() => {
    if (!open || resetStatus !== "completed") return;
    const timeout = window.setTimeout(() => {
      setMessage("");
      setError("");
      setRequestId("");
      setResetStatus("idle");
      onOpenChange(false);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [onOpenChange, open, resetStatus]);

  const remainingSeconds = Math.max(0, Math.ceil((cooldownEnd - now) / 1000));
  const isArchived = staff?.accountStatus === "archived";

  const sendReset = async () => {
    if (!staff || isArchived) return;
    let createdRequestId = "";
    try {
      setIsProcessing(true);
      setError("");
      setMessage("");
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: staff.email }),
      });
      const result = await readResetResponse(response);
      if (!result.requestId) throw new Error("Unable to prepare this password reset request.");
      createdRequestId = result.requestId;
      if (result.cooldownEndsAt) {
        setCooldownEnd(Date.parse(result.cooldownEndsAt));
        setNow(Date.now());
      }
      await sendNativePasswordReset(staff.email, createdRequestId);
      setRequestId(createdRequestId);
      setResetStatus("active");
      setMessage(`Reset email sent to ${staff.email}. Open the link to choose a new password.`);
    } catch (caughtError) {
      if (createdRequestId) {
        await fetch("/api/auth/password-reset", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: createdRequestId }),
        }).catch(() => undefined);
      }
      const cooldownEndsAt = (caughtError as { cooldownEndsAt?: string }).cooldownEndsAt;
      if (cooldownEndsAt) {
        setCooldownEnd(Date.parse(cooldownEndsAt));
        setNow(Date.now());
      }
      setResetStatus("error");
      setError(getFirebaseEmailError(caughtError));
    } finally {
      setIsProcessing(false);
    }
  };

  const cancelReset = async () => {
    if (!requestId || resetStatus !== "active") return;
    const previousMessage = message;
    setIsProcessing(true);
    setResetStatus("cancelled");
    setMessage("Password reset request cancelled.");
    setError("");
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const result = await readResetResponse(response);
      if (result.status === "completed") {
        setResetStatus("completed");
        setMessage("Firebase confirmed that this account's password was changed successfully.");
      }
    } catch (caughtError) {
      setResetStatus("active");
      setMessage(previousMessage);
      setError(getFirebaseEmailError(caughtError));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (isProcessing) return;
    if (!nextOpen && resetStatus !== "active") {
      setMessage("");
      setError("");
      setRequestId("");
      setResetStatus("idle");
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isProcessing}>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Send a secure, single-use password reset link to {staff?.email ?? "this staff account"}.
          </DialogDescription>
        </DialogHeader>

        {isProcessing && (
          <Alert>
            <Spinner />
            <AlertTitle>{resetStatus === "cancelled" ? "Cancelling reset" : "Sending reset email"}</AlertTitle>
            <AlertDescription>Please wait while SmartRoad updates this password reset request.</AlertDescription>
          </Alert>
        )}
        {!isProcessing && message && resetStatus === "active" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Reset email sent</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {!isProcessing && message && resetStatus === "cancelled" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Password reset cancelled</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {!isProcessing && message && resetStatus === "completed" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Password reset successful</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Unable to update password reset</AlertTitle>
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
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isProcessing}>
            Close
          </Button>
          {resetStatus === "active" ? (
            <Button type="button" variant="destructive" onClick={() => void cancelReset()} disabled={isProcessing}>
              {isProcessing && <Spinner data-icon="inline-start" />}
              Cancel reset
            </Button>
          ) : (
            resetStatus !== "completed" &&
            !(isProcessing && resetStatus === "cancelled") && (
              <Button
                type="button"
                onClick={() => void sendReset()}
                disabled={isProcessing || isArchived || remainingSeconds > 0}
              >
                {isProcessing ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
                {remainingSeconds > 0 ? `Resend in ${formatCountdown(remainingSeconds)}` : "Send reset link"}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
