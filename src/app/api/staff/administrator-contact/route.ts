import { adminDb } from "@/lib/firebase/admin";
import { authenticateStaff, errorResponse, normalizeEmail } from "@/lib/firebase/admin-staff";

export async function GET(request: Request) {
  try {
    const currentStaff = await authenticateStaff(request);
    if (currentStaff.role === "Administrator") return Response.json({ email: currentStaff.email });

    const administrators = await adminDb.collection("staff").where("role", "==", "Administrator").get();
    const emails = administrators.docs
      .filter((document) => {
        const data = document.data();
        return data.accountStatus !== "archived" && data.status !== "archived";
      })
      .map((document) => normalizeEmail(String(document.data().email || "")))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    return Response.json({ email: emails[0] ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
