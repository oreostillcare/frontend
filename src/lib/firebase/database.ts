import { onValue, ref, type Unsubscribe } from "firebase/database";

import { database } from "./client";

export function subscribeToPath<T>(path: string, callback: (value: T | null) => void): Unsubscribe {
  if (!database) {
    callback(null);
    return () => undefined;
  }
  return onValue(ref(database, path), (snapshot) => callback(snapshot.exists() ? (snapshot.val() as T) : null));
}
