"use client";

import { auth } from "./client";

export interface StaffApiErrorPayload {
  error?: string;
  code?: string;
  cooldownEndsAt?: string;
}

export class StaffApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public cooldownEndsAt?: string,
  ) {
    super(message);
  }
}

export async function staffApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const user = auth?.currentUser;
  if (!user) throw new Error("Authentication required.");

  const token = await user.getIdToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const payload = (await response.json()) as T & StaffApiErrorPayload;
  if (!response.ok) {
    throw new StaffApiError(
      payload.error ?? "The SmartRoad server request failed.",
      response.status,
      payload.code,
      payload.cooldownEndsAt,
    );
  }
  return payload;
}
