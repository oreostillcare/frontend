"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";

export function AccountPanel() {
  const { user, name, email, logout, isLoggingOut } = useFirebaseAccount();

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Authenticated monitoring user</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-muted-foreground text-sm">Name</p>
          <p className="font-medium">{name}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-sm">Email</p>
          <p className="font-medium">{email}</p>
        </div>
        <Button className="w-fit" variant="outline" onClick={() => void logout()} disabled={!user || isLoggingOut}>
          {isLoggingOut ? "Logging out..." : "Log out"}
        </Button>
      </CardContent>
    </Card>
  );
}
