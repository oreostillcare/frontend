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
  const isCheckingStaffAccess = Boolean(configured && user && staffLoading);
  const isMissingStaffAccess = Boolean(configured && user && !staffLoading && !staffRole);
  const isStaffAccessDenied = Boolean(user && isStaffRoute && !staffLoading && staffRole !== "Administrator");
  const isAccessDenied = isMissingStaffAccess || isStaffAccessDenied;

  useEffect(() => {
    if (!loading && configured && !user) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (isAccessDenied) {
      router.replace("/unauthorized");
    }
  }, [configured, isAccessDenied, loading, pathname, router, user]);

  if (loading || (configured && !user) || isCheckingStaffAccess || isAccessDenied)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
        <span className="ml-2 text-muted-foreground">
          {isCheckingStaffAccess || isAccessDenied ? "Checking permissions..." : "Checking session..."}
        </span>
      </div>
    );
  return children;
}
