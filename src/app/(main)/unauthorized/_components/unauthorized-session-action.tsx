"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";

export function UnauthorizedSessionAction() {
  const { logout, isLoggingOut } = useFirebaseAccount();

  return (
    <Button type="button" onClick={() => void logout()} disabled={isLoggingOut}>
      {isLoggingOut && <Spinner data-icon="inline-start" />}
      {isLoggingOut ? "Clearing session..." : "Go to Homepage"}
    </Button>
  );
}
