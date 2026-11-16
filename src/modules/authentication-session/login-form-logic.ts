import { z } from "zod";

// Pure validation, identifier resolution, and login-lockout helpers used by the form.

export const formSchema = z.object({
  identifier: z.string().min(1, { message: "Please enter your username or email address." }),
  password: z.string().min(1, { message: "Please enter your password." }),
});

interface LoginAttemptRecord {
  aliases: string[];
  failedAttempts: number;
  lockedUntil: number;
}

type LoginAttemptStore = Record<string, LoginAttemptRecord>;

const LOGIN_ATTEMPTS_STORAGE_KEY = "smartroad.login-attempts.v2";
const LOGIN_LOCK_MS = 30_000;
let volatileLoginAttemptStore: LoginAttemptStore = {};

export function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function readLoginAttemptStore(): LoginAttemptStore {
  try {
    const stored = window.localStorage.getItem(LOGIN_ATTEMPTS_STORAGE_KEY);
    volatileLoginAttemptStore = stored ? (JSON.parse(stored) as LoginAttemptStore) : volatileLoginAttemptStore;
    return volatileLoginAttemptStore;
  } catch {
    return volatileLoginAttemptStore;
  }
}

function writeLoginAttemptStore(store: LoginAttemptStore) {
  volatileLoginAttemptStore = store;
  try {
    window.localStorage.setItem(LOGIN_ATTEMPTS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // The in-memory store still enforces the current page lock when browser storage is unavailable.
  }
}

export function findLoginAttemptRecord(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const store = readLoginAttemptStore();
  const match = Object.entries(store).find(
    ([email, record]) => email === normalizedIdentifier || record.aliases.includes(normalizedIdentifier),
  );
  if (!match) return null;

  const [email, record] = match;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    delete store[email];
    writeLoginAttemptStore(store);
    return null;
  }
  return { email, record };
}

export function recordFailedLogin(email: string, identifier: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const store = readLoginAttemptStore();
  const current = store[normalizedEmail];
  const currentAttempts =
    current?.lockedUntil && current.lockedUntil <= Date.now() ? 0 : (current?.failedAttempts ?? 0);
  const failedAttempts = currentAttempts + 1;
  const lockedUntil = failedAttempts >= 3 ? Date.now() + LOGIN_LOCK_MS : 0;
  const aliases = Array.from(new Set([normalizedEmail, normalizedIdentifier, ...(current?.aliases ?? [])]));
  const record = { aliases, failedAttempts, lockedUntil };
  store[normalizedEmail] = record;
  writeLoginAttemptStore(store);
  return record;
}

export function clearLoginAttemptRecord(email: string) {
  const store = readLoginAttemptStore();
  delete store[email.trim().toLowerCase()];
  writeLoginAttemptStore(store);
}

export async function resolveLoginEmail(identifier: string) {
  const response = await fetch("/api/auth/resolve-identifier", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier }),
  });
  const payload = (await response.json()) as { email?: string; error?: string };
  if (!response.ok || !payload.email) throw new Error(payload.error ?? "Invalid username/email or password.");
  return payload.email;
}
