import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import definitions from "../modules/notifications/email-template-definitions.json" with { type: "json" };

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.GCLOUD_PROJECT;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
const missingConfig = [
  !projectId && "FIREBASE_ADMIN_PROJECT_ID",
  !clientEmail && "FIREBASE_ADMIN_CLIENT_EMAIL",
  !privateKey && "FIREBASE_ADMIN_PRIVATE_KEY",
].filter(Boolean);

if (missingConfig.length > 0) {
  throw new Error(`Missing Firebase Admin configuration: ${missingConfig.join(", ")}`);
}

const app =
  getApps()[0] ??
  initializeApp({
    projectId,
    credential: cert({ projectId, clientEmail, privateKey }),
  });
const db = getFirestore(app);
const collection = db.collection("emailTemplates");

if (process.argv.includes("--delete")) {
  await Promise.all(definitions.map((template) => collection.doc(template.id).delete()));
  console.log(`Deleted ${definitions.length} email template documents from ${projectId}.`);
} else {
  const batch = db.batch();
  for (const template of definitions) {
    batch.set(
      collection.doc(template.id),
      {
        ...template,
        channel: "email",
        active: true,
        version: 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await batch.commit();
  console.log(`Upserted ${definitions.length} email template documents in ${projectId}/emailTemplates.`);
}
