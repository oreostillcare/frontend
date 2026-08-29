import { VerifyEmailChange } from "./_components/verify-email-change";

export default async function VerifyEmailChangePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <VerifyEmailChange token={token} />;
}
