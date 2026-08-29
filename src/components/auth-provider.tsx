"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";

import { auth, initializeFirebaseAnalytics, isFirebaseConfigured } from "@/lib/firebase/client";
import {
  loadAdministratorEmail,
  type StaffProfile,
  type StaffRole,
  subscribeToStaffProfile,
} from "@/lib/firebase/staff-access";

interface AuthState {
  user: User | null;
  loading: boolean;
  configured: boolean;
  staffProfile: StaffProfile | null;
  staffRole: StaffRole | null;
  staffLoading: boolean;
  administratorEmail: string | null;
}

interface StaffAccessState {
  userId: string | null;
  profile: StaffProfile | null;
  administratorEmail: string | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  configured: isFirebaseConfigured,
  staffProfile: null,
  staffRole: null,
  staffLoading: true,
  administratorEmail: null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  const [staffAccess, setStaffAccess] = useState<StaffAccessState>({
    userId: null,
    profile: null,
    administratorEmail: null,
    loading: Boolean(auth),
  });

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

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!user) {
      setStaffAccess({ userId: null, profile: null, administratorEmail: null, loading: false });
      return;
    }

    let isCurrent = true;
    setStaffAccess({ userId: user.uid, profile: null, administratorEmail: null, loading: true });

    const unsubscribe = subscribeToStaffProfile(
      user,
      (profile) => {
        if (!isCurrent) return;
        setStaffAccess((current) => ({
          userId: user.uid,
          profile,
          administratorEmail: current.userId === user.uid ? current.administratorEmail : null,
          loading: false,
        }));

        if (profile) {
          void loadAdministratorEmail(user).then((administratorEmail) => {
            if (!isCurrent) return;
            setStaffAccess((current) => (current.userId === user.uid ? { ...current, administratorEmail } : current));
          });
        }
      },
      (error) => {
        console.warn("Could not subscribe to the authenticated staff profile:", error);
        if (isCurrent) {
          setStaffAccess({ userId: user.uid, profile: null, administratorEmail: null, loading: false });
        }
      },
    );

    return () => {
      isCurrent = false;
      unsubscribe();
    };
  }, [loading, user]);

  const value = useMemo(() => {
    const accessMatchesUser = Boolean(user && staffAccess.userId === user.uid);
    const staffProfile = accessMatchesUser ? staffAccess.profile : null;

    return {
      user,
      loading,
      configured: isFirebaseConfigured,
      staffProfile,
      staffRole: staffProfile?.role ?? null,
      staffLoading: loading || Boolean(user && (!accessMatchesUser || staffAccess.loading)),
      administratorEmail: accessMatchesUser ? staffAccess.administratorEmail : null,
    };
  }, [loading, staffAccess, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
