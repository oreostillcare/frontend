"use client";

import * as React from "react";

import { useRouter } from "next/navigation";

import { FirebaseError } from "firebase/app";
import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { auth } from "@/lib/firebase/client";

interface ResetPasswordFormProps {
  mode: string;
  oobCode: string;
  requestId: string;
}

type ResetPageState = "checking" | "ready" | "submitting" | "success" | "error";

const CANCELLED_RESET_MESSAGE = "This password reset request has been cancelled. Please request a new reset link.";

async function updateResetRequest(requestId: string, email: string, action: "claim" | "release" | "complete") {
  const response = await fetch("/api/auth/password-reset", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, email, action }),
  });
  const payload = (await response.json()) as { status?: string; error?: string };
  if (!response.ok) throw new Error(payload.error ?? CANCELLED_RESET_MESSAGE);
  return payload;
}

function getResetError(error: unknown) {
  if (error instanceof FirebaseError) {
    if (
      error.code === "auth/expired-action-code" ||
      error.code === "auth/invalid-action-code" ||
      error.code === "auth/user-disabled" ||
      error.code === "auth/user-not-found"
    ) {
      return CANCELLED_RESET_MESSAGE;
    }
    if (error.code === "auth/weak-password") return "Use a stronger password with at least 6 characters.";
  }
  return error instanceof Error ? error.message : "Unable to reset the password. Please request a new reset link.";
}

export function ResetPasswordForm({ mode, oobCode, requestId }: ResetPasswordFormProps) {
  const router = useRouter();
  const [state, setState] = React.useState<ResetPageState>("checking");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;

    const validateRequest = async () => {
      if (!auth || mode !== "resetPassword" || !oobCode || !requestId) {
        setState("error");
        setMessage(CANCELLED_RESET_MESSAGE);
        return;
      }

      try {
        const verifiedEmail = await verifyPasswordResetCode(auth, oobCode);
        const response = await fetch(`/api/auth/password-reset?requestId=${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as { status?: "active" | "completed"; error?: string };
        if (!response.ok || payload.status !== "active") {
          throw new Error(payload.error ?? CANCELLED_RESET_MESSAGE);
        }
        if (cancelled) return;
        setEmail(verifiedEmail.trim().toLowerCase());
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        setState("error");
        setMessage(getResetError(error));
      }
    };

    void validateRequest();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode, requestId]);

  React.useEffect(() => {
    if (state !== "success") return;
    const timeout = window.setTimeout(() => {
      setPassword("");
      setConfirmPassword("");
      setMessage("");
      router.replace(`/login?passwordReset=success&requestId=${encodeURIComponent(requestId)}`);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [requestId, router, state]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth || state !== "ready") return;
    if (password.length < 6) {
      setMessage("Use a stronger password with at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("The passwords do not match.");
      return;
    }

    let claimed = false;
    let passwordChanged = false;
    try {
      setState("submitting");
      setMessage("");
      const verifiedEmail = await verifyPasswordResetCode(auth, oobCode);
      await updateResetRequest(requestId, verifiedEmail, "claim");
      claimed = true;
      await confirmPasswordReset(auth, oobCode, password);
      passwordChanged = true;
      await updateResetRequest(requestId, verifiedEmail, "complete");
      setState("success");
      setMessage("Your password was changed successfully. You can now sign in with your new password.");
    } catch (error) {
      if (claimed && !passwordChanged) await updateResetRequest(requestId, email, "release").catch(() => undefined);
      if (passwordChanged) {
        const response = await fetch(`/api/auth/password-reset?requestId=${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        }).catch(() => null);
        if (response?.ok) {
          const payload = (await response.json()) as { status?: "active" | "completed" };
          if (payload.status === "completed") {
            setState("success");
            setMessage("Your password was changed successfully. You can now sign in with your new password.");
            return;
          }
        }
        setState("success");
        setMessage("Your password was changed successfully. You can now sign in with your new password.");
        return;
      }
      const errorMessage = getResetError(error);
      setState(errorMessage === CANCELLED_RESET_MESSAGE ? "error" : "ready");
      setMessage(errorMessage);
    }
  };

  const handleCancel = async () => {
    await fetch("/api/auth/password-reset", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    }).catch(() => undefined);
    router.replace("/login");
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>Create a new password for your SmartRoad staff account.</CardDescription>
      </CardHeader>
      <CardContent>
        {state === "checking" && (
          <Alert>
            <Spinner />
            <AlertTitle>Checking reset request</AlertTitle>
            <AlertDescription>Please wait while SmartRoad verifies this Firebase reset link.</AlertDescription>
          </Alert>
        )}

        {state === "success" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Password reset successful</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        {state === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Unable to reset password</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        {(state === "ready" || state === "submitting") && (
          <form id="reset-password-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reset-account-email">Email address</FieldLabel>
                <Input id="reset-account-email" value={email} disabled readOnly />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setMessage("");
                  }}
                  autoComplete="new-password"
                  disabled={state === "submitting"}
                  required
                />
                <FieldDescription>Use at least 6 characters.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-new-password">Confirm new password</FieldLabel>
                <Input
                  id="confirm-new-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    setMessage("");
                  }}
                  autoComplete="new-password"
                  disabled={state === "submitting"}
                  required
                />
              </Field>
            </FieldGroup>
            {message && <p className="text-destructive text-sm">{message}</p>}
          </form>
        )}
      </CardContent>
      {(state === "ready" || state === "submitting") && (
        <CardFooter className="justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void handleCancel()} disabled={state === "submitting"}>
            Cancel
          </Button>
          <Button type="submit" form="reset-password-form" disabled={state === "submitting"}>
            {state === "submitting" && <Spinner data-icon="inline-start" />}
            {state === "submitting" ? "Resetting password..." : "Reset password"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
