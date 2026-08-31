"use client";

import * as React from "react";

import { useRouter } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { FirebaseError } from "firebase/app";
import { browserSessionPersistence, setPersistence, signInWithEmailAndPassword } from "firebase/auth";
import { CheckCircle2, Eye, EyeOff, KeyRound } from "lucide-react";
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { getFirebaseEmailError, sendNativePasswordReset } from "@/lib/firebase/auth-email";
import { auth } from "@/lib/firebase/client";

const formSchema = z.object({
  identifier: z.string().min(1, { message: "Please enter your username or email address." }),
  password: z.string().min(1, { message: "Please enter your password." }),
});

interface LoginAttemptRecord {
  aliases: string[];
  failedAttempts: number;
  lockedUntil: number;
}

type LoginAttemptStore = Record<string, LoginAttemptRecord>;

const LOGIN_ATTEMPTS_STORAGE_KEY = "smartroad.login-attempts.v2";
const LOGIN_LOCK_MS = 30_000;
let volatileLoginAttemptStore: LoginAttemptStore = {};

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function readLoginAttemptStore(): LoginAttemptStore {
  try {
    const stored = window.localStorage.getItem(LOGIN_ATTEMPTS_STORAGE_KEY);
    volatileLoginAttemptStore = stored ? (JSON.parse(stored) as LoginAttemptStore) : volatileLoginAttemptStore;
    return volatileLoginAttemptStore;
  } catch {
    return volatileLoginAttemptStore;
  }
}

function writeLoginAttemptStore(store: LoginAttemptStore) {
  volatileLoginAttemptStore = store;
  try {
    window.localStorage.setItem(LOGIN_ATTEMPTS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // The in-memory store still enforces the current page lock when browser storage is unavailable.
  }
}

function findLoginAttemptRecord(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const store = readLoginAttemptStore();
  const match = Object.entries(store).find(
    ([email, record]) => email === normalizedIdentifier || record.aliases.includes(normalizedIdentifier),
  );
  if (!match) return null;

  const [email, record] = match;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    delete store[email];
    writeLoginAttemptStore(store);
    return null;
  }
  return { email, record };
}

function recordFailedLogin(email: string, identifier: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const store = readLoginAttemptStore();
  const current = store[normalizedEmail];
  const currentAttempts =
    current?.lockedUntil && current.lockedUntil <= Date.now() ? 0 : (current?.failedAttempts ?? 0);
  const failedAttempts = currentAttempts + 1;
  const lockedUntil = failedAttempts >= 3 ? Date.now() + LOGIN_LOCK_MS : 0;
  const aliases = Array.from(new Set([normalizedEmail, normalizedIdentifier, ...(current?.aliases ?? [])]));
  const record = { aliases, failedAttempts, lockedUntil };
  store[normalizedEmail] = record;
  writeLoginAttemptStore(store);
  return record;
}

function clearLoginAttemptRecord(email: string) {
  const store = readLoginAttemptStore();
  delete store[email.trim().toLowerCase()];
  writeLoginAttemptStore(store);
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
  const [resetState, setResetState] = React.useState<"idle" | "active" | "cancelled" | "completed" | "error">("idle");
  const [resetMessage, setResetMessage] = React.useState("");
  const [resetError, setResetError] = React.useState("");
  const [resetRequestId, setResetRequestId] = React.useState("");
  const [resetCooldownEnd, setResetCooldownEnd] = React.useState(0);
  const [resetNow, setResetNow] = React.useState(Date.now());
  const [loginNotice, setLoginNotice] = React.useState("");
  const [loginFailedAttempts, setLoginFailedAttempts] = React.useState(0);
  const [loginLockedUntil, setLoginLockedUntil] = React.useState(0);
  const [loginLockedEmail, setLoginLockedEmail] = React.useState("");
  const [loginNow, setLoginNow] = React.useState(Date.now());
  const [lastResolvedEmail, setLastResolvedEmail] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      identifier: "",
      password: "",
    },
  });
  const currentIdentifier = form.watch("identifier");

  React.useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("passwordReset") !== "success") return;
    const requestId = currentUrl.searchParams.get("requestId");
    currentUrl.searchParams.delete("passwordReset");
    currentUrl.searchParams.delete("requestId");
    window.history.replaceState(window.history.state, "", currentUrl);

    if (!requestId) return;
    const verifyCompletedReset = async () => {
      try {
        const response = await fetch(`/api/auth/password-reset?requestId=${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as { status?: "active" | "completed" };
        if (response.ok && payload.status === "completed") {
          setLoginNotice("Your password was reset successfully. Sign in using your new password.");
        }
      } catch {
        // Do not show a success message unless the tracked Firebase reset can be confirmed.
      }
    };
    void verifyCompletedReset();
  }, []);

  React.useEffect(() => {
    if (!loginNotice) return;
    const timeout = window.setTimeout(() => setLoginNotice(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [loginNotice]);

  React.useEffect(() => {
    if (!resetOpen || resetState !== "active" || !resetRequestId) return;
    let cancelled = false;

    const checkResetStatus = async () => {
      try {
        const response = await fetch(`/api/auth/password-reset?requestId=${encodeURIComponent(resetRequestId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as { status?: "active" | "completed"; error?: string };
        if (!response.ok && response.status === 410) {
          if (cancelled) return;
          setResetState("cancelled");
          setResetMessage(payload.error ?? "Password reset request cancelled.");
          setResetError("");
          return;
        }
        if (!response.ok) throw new Error(payload.error ?? "Unable to check the password reset status.");
        if (cancelled || payload.status !== "completed") return;
        setResetState("completed");
        setResetMessage("Firebase confirmed that your password was changed successfully.");
        setResetError("");
      } catch (error) {
        if (cancelled) return;
        setResetError(error instanceof Error ? error.message : "Unable to check the password reset status.");
      }
    };

    void checkResetStatus();
    const interval = window.setInterval(() => void checkResetStatus(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [resetOpen, resetRequestId, resetState]);

  React.useEffect(() => {
    if (!resetOpen || resetState !== "completed") return;
    const timeout = window.setTimeout(() => {
      setResetOpen(false);
      setResetState("idle");
      setResetMessage("");
      setResetError("");
      setResetRequestId("");
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [resetOpen, resetState]);

  React.useEffect(() => {
    if (!resetOpen || resetCooldownEnd <= Date.now()) return;
    setResetNow(Date.now());
    const interval = window.setInterval(() => setResetNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [resetCooldownEnd, resetOpen]);

  React.useEffect(() => {
    const match = findLoginAttemptRecord(currentIdentifier);
    if (!match) {
      setLoginFailedAttempts(0);
      setLoginLockedUntil(0);
      setLoginLockedEmail("");
      return;
    }

    setLoginFailedAttempts(match.record.failedAttempts);
    setLoginLockedUntil(match.record.lockedUntil);
    setLoginLockedEmail(match.email);
    setLoginNow(Date.now());
  }, [currentIdentifier]);

  React.useEffect(() => {
    if (!loginLockedUntil || loginLockedUntil <= Date.now()) return;
    setLoginNow(Date.now());
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setLoginNow(currentTime);
      if (currentTime < loginLockedUntil) return;
      if (loginLockedEmail) clearLoginAttemptRecord(loginLockedEmail);
      setLoginFailedAttempts(0);
      setLoginLockedUntil(0);
      setLoginLockedEmail("");
    }, 1000);
    return () => window.clearInterval(interval);
  }, [loginLockedEmail, loginLockedUntil]);

  async function handlePasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = resetEmail.trim().toLowerCase();
    if (!email) {
      setResetState("error");
      setResetMessage("Enter the email address connected to your staff account.");
      return;
    }

    let requestId = "";
    try {
      setResetPending(true);
      setResetState("idle");
      setResetMessage("");
      setResetError("");
      const trackingResponse = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const trackingPayload = (await trackingResponse.json()) as {
        requestId?: string;
        cooldownEndsAt?: string;
        error?: string;
      };
      if (!trackingResponse.ok || !trackingPayload.requestId) {
        if (trackingPayload.cooldownEndsAt) {
          setResetCooldownEnd(Date.parse(trackingPayload.cooldownEndsAt));
          setResetNow(Date.now());
        }
        throw new Error(trackingPayload.error ?? "Unable to prepare this password reset.");
      }
      requestId = trackingPayload.requestId;
      if (trackingPayload.cooldownEndsAt) {
        setResetCooldownEnd(Date.parse(trackingPayload.cooldownEndsAt));
        setResetNow(Date.now());
      }
      await sendNativePasswordReset(email, requestId);
      setResetRequestId(requestId);
      setResetState("active");
      setResetMessage("Reset email sent. Open the link from your inbox to choose a new password.");
    } catch (error) {
      console.error("Password reset error:", error);
      if (requestId) {
        await fetch("/api/auth/password-reset", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        }).catch(() => undefined);
      }
      setResetState("error");
      setResetMessage(getFirebaseEmailError(error));
    } finally {
      setResetPending(false);
    }
  }

  async function cancelPasswordReset() {
    if (!resetRequestId || resetState !== "active") return;
    const previousMessage = resetMessage;
    setResetPending(true);
    setResetState("cancelled");
    setResetMessage("Password reset request cancelled.");
    setResetError("");
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: resetRequestId }),
      });
      const payload = (await response.json()) as { status?: "cancelled" | "completed"; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to cancel the password reset request.");
      if (payload.status === "completed") {
        setResetState("completed");
        setResetMessage("Firebase confirmed that your password was changed successfully.");
      }
    } catch (error) {
      setResetState("active");
      setResetMessage(previousMessage);
      setResetError(error instanceof Error ? error.message : "Unable to cancel the password reset request.");
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

      const existingAttempt = findLoginAttemptRecord(resolvedEmail);
      if (existingAttempt?.record.lockedUntil && existingAttempt.record.lockedUntil > Date.now()) {
        setLoginFailedAttempts(existingAttempt.record.failedAttempts);
        setLoginLockedUntil(existingAttempt.record.lockedUntil);
        setLoginLockedEmail(existingAttempt.email);
        setLoginNow(Date.now());
        form.clearErrors("root");
        return;
      }

      await signInWithEmailAndPassword(auth, resolvedEmail, data.password);
      clearLoginAttemptRecord(resolvedEmail);
      setLoginFailedAttempts(0);
      setLoginLockedUntil(0);
      setLoginLockedEmail("");
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
      if (isCredentialMistake && resolvedEmail) {
        const attempt = recordFailedLogin(resolvedEmail, data.identifier);
        setLoginFailedAttempts(attempt.failedAttempts);
        setLoginLockedUntil(attempt.lockedUntil);
        setLoginLockedEmail(resolvedEmail.trim().toLowerCase());
        setLoginNow(Date.now());
      }
      if (resolvedEmail) setLastResolvedEmail(resolvedEmail);
      form.setError("root", {
        message,
      });
    }
  }

  const openPasswordReset = () => {
    if (resetState === "active") {
      setResetOpen(true);
      return;
    }
    const identifier = form.getValues("identifier").trim().toLowerCase();
    setResetEmail(lastResolvedEmail || (identifier.includes("@") ? identifier : ""));
    setResetState("idle");
    setResetMessage("");
    setResetError("");
    setResetRequestId("");
    setResetOpen(true);
  };

  const handleResetOpenChange = (nextOpen: boolean) => {
    if (resetPending) return;
    setResetOpen(nextOpen);
    if (!nextOpen && resetState !== "active") {
      setResetState("idle");
      setResetMessage("");
      setResetError("");
      setResetRequestId("");
    }
  };

  const remainingResetCooldown = Math.max(0, Math.ceil((resetCooldownEnd - resetNow) / 1000));
  const remainingLoginCooldown = Math.max(0, Math.ceil((loginLockedUntil - loginNow) / 1000));
  const loginIsLocked = remainingLoginCooldown > 0;
  let resetActionLabel = "Send reset email";
  if (resetPending) resetActionLabel = "Sending reset email...";
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
              <InputGroup>
                <InputGroupInput
                  {...field}
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  aria-invalid={fieldState.invalid}
                  disabled={form.formState.isSubmitting}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    size="icon-xs"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((visible) => !visible)}
                    disabled={form.formState.isSubmitting}
                  >
                    {showPassword ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              {loginIsLocked && (
                <p className="text-destructive text-sm" role="status" aria-live="polite" aria-atomic="true">
                  Too many sign-in attempts. Try again in {remainingLoginCooldown} seconds.
                </p>
              )}
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
      {loginFailedAttempts >= 3 && loginIsLocked && (
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
      <Button className="w-full" disabled={form.formState.isSubmitting || loginIsLocked} type="submit">
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
          <form className="flex flex-col gap-4" onSubmit={handlePasswordReset} aria-busy={resetPending}>
            <DialogHeader>
              <DialogTitle>Reset your password</DialogTitle>
              <DialogDescription>
                SmartRoad will email a secure, single-use reset link to your staff account.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field
                data-disabled={resetPending || resetState === "active" || resetState === "completed" || undefined}
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
                    setResetError("");
                  }}
                  autoComplete="email"
                  placeholder="name@example.com"
                  aria-invalid={resetState === "error"}
                  disabled={resetPending || resetState === "active" || resetState === "completed"}
                  required
                />
              </Field>
            </FieldGroup>
            {resetPending && (
              <Alert>
                <Spinner />
                <AlertTitle>{resetState === "cancelled" ? "Cancelling reset" : "Sending reset email"}</AlertTitle>
                <AlertDescription>
                  {resetState === "cancelled"
                    ? "Please wait while SmartRoad cancels this request."
                    : "Please wait while Firebase prepares your secure reset link."}
                </AlertDescription>
              </Alert>
            )}
            {!resetPending && resetState === "active" && (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Reset email sent</AlertTitle>
                <AlertDescription>{resetMessage}</AlertDescription>
              </Alert>
            )}
            {!resetPending && resetState === "cancelled" && (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Password reset cancelled</AlertTitle>
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
            {!resetPending && resetError && (
              <Alert variant="destructive">
                <AlertTitle>Unable to cancel password reset</AlertTitle>
                <AlertDescription>{resetError}</AlertDescription>
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
                Close
              </Button>
              {resetState === "active" ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="w-full sm:w-auto"
                  onClick={() => void cancelPasswordReset()}
                  disabled={resetPending}
                >
                  {resetPending && <Spinner data-icon="inline-start" />}
                  Cancel reset
                </Button>
              ) : (
                resetState !== "completed" &&
                !(resetPending && resetState === "cancelled") && (
                  <Button
                    type="submit"
                    className="w-full sm:w-auto"
                    disabled={resetPending || remainingResetCooldown > 0}
                  >
                    {resetPending && <Spinner data-icon="inline-start" />}
                    {resetActionLabel}
                  </Button>
                )
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </form>
  );
}
