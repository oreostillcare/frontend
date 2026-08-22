"use client";

import { useCallback, useState } from "react";

import { useRouter } from "next/navigation";

import { signOut } from "firebase/auth";

import { useAuth } from "@/components/auth-provider";
import { auth } from "@/lib/firebase/client";

export function useFirebaseAccount() {
  const { user, configured } = useAuth();
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const email = user?.email ?? (configured ? "Email unavailable" : "Firebase not configured");
  const name = user?.displayName?.trim() || user?.email?.split("@")[0] || "Local user";
  const avatar = user?.photoURL ?? "";

  const logout = useCallback(async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      if (auth) await signOut(auth);
      router.replace("/login");
      router.refresh();
    } catch {
      setIsLoggingOut(false);
    }
  }, [isLoggingOut, router]);

  return { user, name, email, avatar, logout, isLoggingOut };
}
