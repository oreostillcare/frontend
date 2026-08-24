"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";

import { auth, initializeFirebaseAnalytics, isFirebaseConfigured } from "@/lib/firebase/client";

interface AuthState {
  user: User | null;
  loading: boolean;
  configured: boolean;
}
const AuthContext = createContext<AuthState>({ user: null, loading: true, configured: isFirebaseConfigured });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));

  useEffect(() => {
    void initializeFirebaseAnalytics();
    if (!auth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
  }, []);

  const value = useMemo(() => ({ user, loading, configured: isFirebaseConfigured }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
