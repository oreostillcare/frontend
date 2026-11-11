import { adminDb } from "@/lib/firebase/admin";
import { authenticateStaff, errorResponse } from "@/lib/firebase/admin-staff";

export async function GET(request: Request) {
  try {
    await authenticateStaff(request);
    const snapshot = await adminDb.collection("nodeSessionLogs").orderBy("occurredAt", "desc").limit(250).get();
    const logs = snapshot.docs.map((document) => {
      const data = document.data();
      const occurredAt = data.occurredAt?.toDate?.();

      return {
        ...data,
        id: document.id,
        occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : null,
      };
    });

    return Response.json({ logs });
  } catch (error) {
    return errorResponse(error);
  }
}
