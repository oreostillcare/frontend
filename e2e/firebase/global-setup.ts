import { resetFirebaseEmulators } from "./emulator-helpers";

export default async function globalSetup() {
  await resetFirebaseEmulators();
}
