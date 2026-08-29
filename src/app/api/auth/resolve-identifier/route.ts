import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, findStaffByEmail, normalizeEmail } from "@/lib/firebase/admin-staff";

const identifierSchema = z.object({ identifier: z.string().trim().min(1).max(254) });

export async function POST(request: Request) {
  try {
    const { identifier } = identifierSchema.parse(await request.json());
    const normalized = identifier.toLowerCase();
    const staffDocument = identifier.includes("@")
      ? await findStaffByEmail(normalizeEmail(identifier))
      : ((
          await adminDb
            .collection("staff")
            .where("username", "in", [...new Set([identifier, normalized])])
            .limit(1)
            .get()
        ).docs[0] ?? null);

    if (!staffDocument?.exists) throw new ApiError("Invalid username/email or password.", 401, "invalid-credential");
    const data = staffDocument.data();
    if (!data) throw new ApiError("Invalid username/email or password.", 401, "invalid-credential");
    if (data.accountStatus === "archived" || data.status === "archived") {
      throw new ApiError("This staff account is archived. Contact an administrator.", 403, "account-archived");
    }
    return Response.json({ email: normalizeEmail(String(data.email || "")) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter your username or email address.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
