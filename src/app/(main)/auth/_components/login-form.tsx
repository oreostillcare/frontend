"use client";

import * as React from "react";

import { useRouter } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { FirebaseError } from "firebase/app";
import { browserSessionPersistence, setPersistence, signInWithEmailAndPassword } from "firebase/auth";
import { CheckCircle2, KeyRound } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getFirebaseEmailError, sendNativePasswordReset } from "@/lib/firebase/auth-email";
import { auth } from "@/lib/firebase/client";

const formSchema = z.object({
  identifier: z.string().min(1, { message: "Please enter your username or email address." }),
  password: z.string().min(1, { message: "Please enter your password." }),
});

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function resolveLoginEmail(identifier: string) {
  const response = await fetch("/api/auth/resolve-identifier", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier }),
  });
  const payload = (await response.json()) as { email?: string; error?: string };
  if (!response.ok || !payload.email) throw new Error(payload.error ?? "Invalid username/email or password.");
  return payload.email;
}

export function LoginForm() {
  const router = useRouter();
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState("");
  const [resetPending, setResetPending] = React.useState(false);
  const [resetState, setResetState] = React.useState<"idle" | "waiting" | "completed" | "error">("idle");
  const [resetMessage, setResetMessage] = React.useState("");
  const [resetTrackingToken, setResetTrackingToken] = React.useState("");
  const [resetCooldownEnd, setResetCooldownEnd] = React.useState(0);
  const [resetNow, setResetNow] = React.useState(Date.now());
  const [loginNotice, setLoginNotice] = React.useState("");
  const [failedAttempts, setFailedAttempts] = React.useState(0);
  const [lastResolvedEmail, setLastResolvedEmail] = React.useState("");
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      identifier: "",
      password: "",
    },
  });

  React.useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("passwordReset") !== "success") return;
    setLoginNotice("Your password was reset successfully. Sign in using your new password.");
    currentUrl.searchParams.delete("passwordReset");
    window.history.replaceState(window.history.state, "", currentUrl);
  }, []);

  React.useEffect(() => {
    if (!resetOpen || resetState !== "waiting" || !resetTrackingToken) return;
    let cancelled = false;

    const checkResetStatus = async () => {
      try {
        const response = await fetch(`/api/auth/password-reset?token=${encodeURIComponent(resetTrackingToken)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as { status?: "pending" | "completed"; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Unable to check the password reset status.");
        if (cancelled || payload.status !== "completed") return;
        setResetState("completed");
        setResetMessage("Firebase confirmed that your password was changed successfully.");
        setLoginNotice("Your password was reset successfully. Sign in using your new password.");
      } catch (error) {
        if (cancelled) return;
        setResetState("error");
        setResetMessage(error instanceof Error ? error.message : "Unable to check the password reset status.");
      }
    };

    void checkResetStatus();
    const interval = window.setInterval(() => void checkResetStatus(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [resetOpen, resetState, resetTrackingToken]);

  React.useEffect(() => {
    if (!resetOpen || resetState !== "completed") return;
    const timeout = window.setTimeout(() => {
      setResetOpen(false);
      setResetState("idle");
      setResetMessage("");
      setResetTrackingToken("");
      router.replace("/login?passwordReset=success");
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [resetOpen, resetState, router]);

  React.useEffect(() => {
    if (!resetOpen || resetCooldownEnd <= Date.now()) return;
    setResetNow(Date.now());
    const interval = window.setInterval(() => setResetNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [resetCooldownEnd, resetOpen]);

  async function handlePasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = resetEmail.trim().toLowerCase();
    if (!email) {
      setResetState("error");
      setResetMessage("Enter the email address connected to your staff account.");
      return;
    }

    let trackingToken = "";
    try {
      setResetPending(true);
      setResetState("idle");
      setResetMessage("");
      const trackingResponse = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const trackingPayload = (await trackingResponse.json()) as {
        trackingToken?: string;
        cooldownEndsAt?: string;
        error?: string;
      };
      if (!trackingResponse.ok || !trackingPayload.trackingToken) {
        if (trackingPayload.cooldownEndsAt) {
          setResetCooldownEnd(Date.parse(trackingPayload.cooldownEndsAt));
          setResetNow(Date.now());
        }
        throw new Error(trackingPayload.error ?? "Unable to prepare this password reset.");
      }
      trackingToken = trackingPayload.trackingToken;
      await sendNativePasswordReset(email);
      if (trackingPayload.cooldownEndsAt) {
        setResetCooldownEnd(Date.parse(trackingPayload.cooldownEndsAt));
        setResetNow(Date.now());
      }
      setResetTrackingToken(trackingToken);
      setResetState("waiting");
      setResetMessage(
        "Reset email sent. Open the link from your inbox; this window will update after the password changes.",
      );
      setFailedAttempts(0);
    } catch (error) {
      console.error("Password reset error:", error);
      if (trackingToken) {
        await fetch("/api/auth/password-reset", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: trackingToken }),
        }).catch(() => undefined);
      }
      setResetState("error");
      setResetMessage(getFirebaseEmailError(error));
    } finally {
      setResetPending(false);
    }
  }

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (!auth) {
      form.setError("root", { message: "Firebase Authentication is not configured." });
      return;
    }

    let resolvedEmail = "";
    try {
      await setPersistence(auth, browserSessionPersistence);

      resolvedEmail = await resolveLoginEmail(data.identifier.trim());
      setLastResolvedEmail(resolvedEmail);

      await signInWithEmailAndPassword(auth, resolvedEmail, data.password);
      setFailedAttempts(0);
      const searchParams = new URLSearchParams(window.location.search);
      const nextPath = searchParams.get("next");
      router.replace(nextPath || "/dashboard");
    } catch (error) {
      console.error("Login error:", error);
      let message = "Unable to sign in. Please verify your credentials and try again.";
      if (error instanceof Error) message = error.message;
      if (
        error instanceof FirebaseError &&
        (error.code === "auth/invalid-credential" ||
          error.code === "auth/user-not-found" ||
          error.code === "auth/wrong-password" ||
          error.code === "auth/invalid-email")
      ) {
        message = "Invalid username/email or password.";
      }
      if (error instanceof FirebaseError && error.code === "auth/operation-not-allowed") {
        message = "Email/password sign-in is not enabled in Firebase Authentication.";
      }
      if (error instanceof FirebaseError && error.code === "auth/network-request-failed") {
        message = "Unable to reach Firebase. Check your connection and try again.";
      }
      if (error instanceof FirebaseError && error.code === "auth/too-many-requests") {
        message = "Too many sign-in attempts. Wait a moment before trying again.";
      }
      const isCredentialMistake =
        message === "Invalid username/email or password." ||
        (error instanceof FirebaseError &&
          (error.code === "auth/invalid-credential" ||
            error.code === "auth/user-not-found" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/invalid-email"));
      if (isCredentialMistake) setFailedAttempts((attempts) => attempts + 1);
      if (resolvedEmail) setLastResolvedEmail(resolvedEmail);
      form.setError("root", {
        message,
      });
    }
  }

  const openPasswordReset = () => {
    const identifier = form.getValues("identifier").trim().toLowerCase();
    setResetEmail(lastResolvedEmail || (identifier.includes("@") ? identifier : ""));
    setResetState("idle");
    setResetMessage("");
    setResetTrackingToken("");
    setResetOpen(true);
  };

  const handleResetOpenChange = (nextOpen: boolean) => {
    if (resetPending) return;
    setResetOpen(nextOpen);
    if (!nextOpen) {
      setResetState("idle");
      setResetMessage("");
      setResetTrackingToken("");
    }
  };

  const remainingResetCooldown = Math.max(0, Math.ceil((resetCooldownEnd - resetNow) / 1000));
  let resetActionLabel = "Send reset email";
  if (resetPending) resetActionLabel = "Sending reset email...";
  else if (resetState === "waiting") resetActionLabel = "Waiting for reset...";
  else if (resetState === "completed") resetActionLabel = "Done";
  else if (remainingResetCooldown > 0) resetActionLabel = `Resend in ${formatCountdown(remainingResetCooldown)}`;

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(onSubmit)}
      className="flex flex-col gap-4"
      aria-busy={form.formState.isSubmitting}
    >
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="identifier"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-identifier">Username or Email</FieldLabel>
              <Input
                {...field}
                id="login-identifier"
                type="text"
                placeholder="Enter username or email address"
                autoComplete="username"
                aria-invalid={fieldState.invalid}
                disabled={form.formState.isSubmitting}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-password">Password</FieldLabel>
              <Input
                {...field}
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                aria-invalid={fieldState.invalid}
                disabled={form.formState.isSubmitting}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      {form.formState.errors.root && (
        <p className="text-destructive text-sm" role="alert">
          {form.formState.errors.root.message}
        </p>
      )}
      {loginNotice && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Password reset successful</AlertTitle>
          <AlertDescription>{loginNotice}</AlertDescription>
        </Alert>
      )}
      {failedAttempts >= 3 && (
        <Alert className="pr-2.5">
          <KeyRound />
          <AlertTitle>Having trouble signing in?</AlertTitle>
          <AlertDescription>
            Three consecutive login attempts failed. You can send a secure password reset link instead.
          </AlertDescription>
          <AlertAction className="static col-start-2 row-start-3 mt-2 justify-self-start">
            <Button type="button" variant="outline" size="sm" onClick={openPasswordReset}>
              Reset password
            </Button>
          </AlertAction>
        </Alert>
      )}
      <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
        {form.formState.isSubmitting && <Spinner data-icon="inline-start" />}
        {form.formState.isSubmitting ? "Signing in..." : "Login"}
      </Button>
      <Dialog open={resetOpen} onOpenChange={handleResetOpenChange}>
        <DialogTrigger asChild>
          <Button type="button" variant="link" className="self-center" onClick={openPasswordReset}>
            Forgot password?
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md" showCloseButton={!resetPending}>
          <form
            className="flex flex-col gap-4"
            onSubmit={handlePasswordReset}
            aria-busy={resetPending || resetState === "waiting"}
          >
            <DialogHeader>
              <DialogTitle>Reset your password</DialogTitle>
              <DialogDescription>
                SmartRoad will email a secure, single-use reset link to your staff account.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field
                data-disabled={resetPending || resetState === "waiting" || resetState === "completed" || undefined}
                data-invalid={resetState === "error" || undefined}
              >
                <FieldLabel htmlFor="reset-email">Email address</FieldLabel>
                <Input
                  id="reset-email"
                  type="email"
                  value={resetEmail}
                  onChange={(event) => {
                    setResetEmail(event.target.value);
                    setResetState("idle");
                    setResetMessage("");
                  }}
                  autoComplete="email"
                  placeholder="name@example.com"
                  aria-invalid={resetState === "error"}
                  disabled={resetPending || resetState === "waiting" || resetState === "completed"}
                  required
                />
              </Field>
            </FieldGroup>
            {resetPending && (
              <Alert>
                <Spinner />
                <AlertTitle>Sending reset email</AlertTitle>
                <AlertDescription>Please wait while Firebase prepares your secure reset link.</AlertDescription>
              </Alert>
            )}
            {!resetPending && resetState === "waiting" && (
              <Alert>
                <Spinner />
                <AlertTitle>Waiting for password change</AlertTitle>
                <AlertDescription>{resetMessage}</AlertDescription>
              </Alert>
            )}
            {!resetPending && resetState === "completed" && (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Password reset successful</AlertTitle>
                <AlertDescription>{resetMessage}</AlertDescription>
              </Alert>
            )}
            {!resetPending && resetState === "error" && (
              <Alert variant="destructive">
                <AlertTitle>Unable to send reset email</AlertTitle>
                <AlertDescription>{resetMessage}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => handleResetOpenChange(false)}
                disabled={resetPending}
              >
                {resetState === "waiting" || resetState === "completed" ? "Close" : "Cancel"}
              </Button>
              <Button
                type={resetState === "completed" ? "button" : "submit"}
                className="w-full sm:w-auto"
                onClick={resetState === "completed" ? () => handleResetOpenChange(false) : undefined}
                disabled={resetPending || resetState === "waiting" || remainingResetCooldown > 0}
              >
                {(resetPending || resetState === "waiting") && <Spinner data-icon="inline-start" />}
                {resetActionLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </form>
  );
}
