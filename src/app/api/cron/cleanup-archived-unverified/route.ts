import { cleanupArchivedUnverifiedAccounts } from "@/lib/firebase/staff-lifecycle";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ success: false, message: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return Response.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await cleanupArchivedUnverifiedAccounts();
    return Response.json(
      {
        success: result.failed.length === 0,
        deleted: result.deleted,
        failed: result.failed.length,
      },
      { status: result.failed.length === 0 ? 200 : 500 },
    );
  } catch (error) {
    console.error("Archived unverified staff cleanup failed:", error);
    return Response.json({ success: false, message: "Cleanup failed." }, { status: 500 });
  }
}
