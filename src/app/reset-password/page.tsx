import { redirect } from "next/navigation";

import { ResetPasswordForm } from "./_components/reset-password-form";

interface ResetPasswordPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const params = await searchParams;
  const mode = firstValue(params.mode) ?? "";
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;

  if (mode && mode !== "resetPassword" && authDomain) {
    const defaultHandler = new URL("/__/auth/action", `https://${authDomain.replace(/^https?:\/\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      const first = firstValue(value);
      if (first) defaultHandler.searchParams.set(key, first);
    }
    redirect(defaultHandler.toString());
  }

  const continueUrl = firstValue(params.continueUrl);
  let requestId = firstValue(params.requestId) ?? "";

  if (!requestId && continueUrl) {
    try {
      requestId = new URL(continueUrl).searchParams.get("requestId") ?? "";
    } catch {
      requestId = "";
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <ResetPasswordForm mode={mode} oobCode={firstValue(params.oobCode) ?? ""} requestId={requestId} />
    </main>
  );
}
