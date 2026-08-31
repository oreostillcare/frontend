"use client";

import * as React from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface InvitationDetails {
  email: string;
  username: string;
  role: "Administrator" | "Operator";
}

async function invitationDetails(token: string) {
  const response = await fetch(`/api/staff/invitations/verify?token=${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as InvitationDetails & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Unable to verify this invitation.");
  return payload;
}

export function CompleteInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [details, setDetails] = React.useState<InvitationDetails | null>(null);
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!token) {
      setError("Invitation token is missing.");
      setIsLoading(false);
      return;
    }
    void invitationDetails(token)
      .then(setDetails)
      .catch((caughtError: unknown) => {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to verify this invitation.");
      })
      .finally(() => setIsLoading(false));
  }, [token]);

  React.useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => router.replace("/login?invitation=completed"), 1500);
    return () => window.clearTimeout(timeout);
  }, [message, router]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!details) return;
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Password confirmation does not match.");
      return;
    }

    try {
      setIsSaving(true);
      setError("");
      await invitationDetails(token);
      const response = await fetch("/api/staff/invitations/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to complete this invitation.");
      setMessage(payload.message ?? "Your account is ready.");
      setDetails(null);
      setPassword("");
      setConfirmation("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to complete this invitation.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Your Password</CardTitle>
          <CardDescription>Choose your login password and activate your SmartRoad staff account.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Spinner /> Verifying invitation...
            </div>
          )}
          {!isLoading && message && (
            <div className="flex flex-col gap-4">
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Verified and active</AlertTitle>
                <AlertDescription>{message} Redirecting to login...</AlertDescription>
              </Alert>
              <Button asChild>
                <Link href="/login">Continue to login</Link>
              </Button>
            </div>
          )}
          {!isLoading && !message && (
            <div className="flex flex-col gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Unable to continue</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {details && (
                <>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <p className="font-medium">{details.username}</p>
                    <p className="text-muted-foreground">{details.email}</p>
                    <p className="text-muted-foreground">{details.role}</p>
                  </div>
                  <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="invitation-password">Password</FieldLabel>
                        <Input
                          id="invitation-password"
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="invitation-confirmation">Confirm password</FieldLabel>
                        <Input
                          id="invitation-confirmation"
                          type="password"
                          value={confirmation}
                          onChange={(event) => setConfirmation(event.target.value)}
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </Field>
                    </FieldGroup>
                    <Button type="submit" disabled={isSaving}>
                      {isSaving && <Spinner data-icon="inline-start" />}
                      Save
                    </Button>
                  </form>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
