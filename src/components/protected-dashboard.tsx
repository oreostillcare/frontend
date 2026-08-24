"use client";

import { useEffect } from "react";

import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/ui/spinner";

export function ProtectedDashboard({ children }: { children: React.ReactNode }) {
  const { user, loading, configured } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && configured && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [configured, loading, pathname, router, user]);

  if (loading || (configured && !user))
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner /> <span className="ml-2 text-muted-foreground">Checking session...</span>
      </div>
    );
  return children;
}
