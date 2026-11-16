import { adminDb } from "@/lib/firebase/admin";

// Reads the latest persisted node-session records for the monitoring view.

export async function readNodeSessionLogs() {
  const snapshot = await adminDb.collection("nodeSessionLogs").orderBy("occurredAt", "desc").limit(250).get();
  return snapshot.docs.map((document) => {
    const data = document.data();
    const occurredAt = data.occurredAt?.toDate?.();

    return {
      ...data,
      id: document.id,
      occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : null,
    };
  });
}
