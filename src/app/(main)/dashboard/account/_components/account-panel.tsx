"use client";

import * as React from "react";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { Eye, EyeOff, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";
import { db } from "@/lib/firebase/client";

interface StaffData {
  username: string;
  email: string;
  password?: string;
  role?: string;
  dateJoined?: string;
}

function getRoleDescription(role?: string) {
  if (role === "Operator") {
    return "Operator (Live View & Monitoring)";
  }
  return "Administrator (Full CRUD & Settings)";
}

export function AccountPanel() {
  const { user, name, email, logout, isLoggingOut } = useFirebaseAccount();
  const [staffData, setStaffData] = React.useState<StaffData | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    async function loadAccountData() {
      if (!user?.email || !db) {
        setIsLoading(false);
        return;
      }

      try {
        const staffRef = collection(db, "staff");
        const q = query(staffRef, where("email", "==", user.email), limit(1));
        const snap = await getDocs(q);

        if (!snap.empty) {
          setStaffData(snap.docs[0].data() as StaffData);
        }
      } catch (error) {
        console.warn("Could not fetch staff details for account page:", error);
      } finally {
        setIsLoading(false);
      }
    }

    loadAccountData();
  }, [user?.email]);

  const username = staffData?.username || name || "User";
  const userRole = getRoleDescription(staffData?.role);
  const userEmail = staffData?.email || email || "Email unavailable";
  const password = staffData?.password || "••••••••";
  const dateJoined =
    staffData?.dateJoined ||
    (user?.metadata?.creationTime
      ? new Date(user.metadata.creationTime).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0]);

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Authenticated monitoring user</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-muted-foreground text-sm">Role</p>
          <p className="font-medium">{isLoading ? "Loading..." : userRole}</p>
        </div>

        <div>
          <p className="text-muted-foreground text-sm">Username</p>
          <p className="font-medium">{isLoading ? "Loading..." : username}</p>
        </div>

        <div>
          <p className="text-muted-foreground text-sm">Email</p>
          <p className="font-medium">{isLoading ? "Loading..." : userEmail}</p>
        </div>

        <div>
          <p className="text-muted-foreground text-sm">Password</p>
          <div className="flex items-center gap-2 font-medium">
            <span className="font-mono text-sm tracking-wider">
              {showPassword ? password : "••••••••"}
            </span>
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        <div>
          <p className="text-muted-foreground text-sm">Date Joined</p>
          <p className="font-medium">{isLoading ? "Loading..." : dateJoined}</p>
        </div>

        <div className="pt-2">
          <Button
            className="w-fit gap-1.5"
            variant="outline"
            onClick={() => void logout()}
            disabled={!user || isLoggingOut}
          >
            <LogOut className="size-4" />
            {isLoggingOut ? "Logging out..." : "Log out"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
