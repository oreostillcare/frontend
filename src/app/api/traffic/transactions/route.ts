import { z } from "zod";

import { persistTrafficTransaction } from "@/modules/firebase-persistence/traffic-transaction-firestore";
import { trafficTransactionSchema } from "@/modules/firebase-persistence/traffic-transaction-validation";

export async function POST(request: Request) {
  const ingestSecret = process.env.TRAFFIC_INGEST_SECRET || process.env.CRON_SECRET;
  if (!ingestSecret) {
    return Response.json({ success: false, message: "Traffic ingest secret is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${ingestSecret}`) {
    return Response.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = trafficTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { success: false, message: "Invalid traffic transaction.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const transaction = parsed.data;

  try {
    await persistTrafficTransaction(transaction);
    return Response.json({
      success: true,
      transactionId: transaction.transactionId,
      vehicleCount: transaction.batchTotal,
    });
  } catch (error) {
    console.error("Traffic transaction persistence failed:", error);
    return Response.json({ success: false, message: "Firestore transaction write failed." }, { status: 500 });
  }
}
