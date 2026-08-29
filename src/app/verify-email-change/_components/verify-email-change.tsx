"use client";

import * as React from "react";

import Link from "next/link";

import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

export function VerifyEmailChange({ token }: { token: string }) {
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!token) {
      setError("Email verification token is missing.");
      return;
    }
    void fetch("/api/staff/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as { message?: string; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Unable to verify this email address.");
        setMessage(payload.message ?? "Email address verified.");
      })
      .catch((caughtError: unknown) => {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to verify this email address.");
      });
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Verify your SmartRoad email</CardTitle>
          <CardDescription>
            Your current login email remains unchanged unless this verification succeeds.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!message && !error && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Spinner /> Verifying email address...
            </div>
          )}
          {message && (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Email verified</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Verification failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {(message || error) && (
            <Button asChild variant={message ? "default" : "outline"}>
              <Link href="/login">Continue to login</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
