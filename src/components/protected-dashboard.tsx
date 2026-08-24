"use client";

import { useEffect } from "react";

import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/ui/spinner";

export function ProtectedDashboard({ children }: { children: React.ReactNode }) {
  const { user, loading, configured, staffRole, staffLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const isStaffRoute = pathname === "/dashboard/staff" || pathname.startsWith("/dashboard/staff/");
  const isCheckingStaffAccess = Boolean(user && isStaffRoute && staffLoading);
  const isStaffAccessDenied = Boolean(user && isStaffRoute && !staffLoading && staffRole !== "Administrator");

  useEffect(() => {
    if (!loading && configured && !user) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (isStaffAccessDenied) {
      router.replace("/unauthorized");
    }
  }, [configured, isStaffAccessDenied, loading, pathname, router, user]);

  if (loading || (configured && !user) || isCheckingStaffAccess || isStaffAccessDenied)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
        <span className="ml-2 text-muted-foreground">
          {isCheckingStaffAccess || isStaffAccessDenied ? "Checking permissions..." : "Checking session..."}
        </span>
      </div>
    );
  return children;
}
