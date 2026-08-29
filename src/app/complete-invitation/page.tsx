import { CompleteInvitationForm } from "./_components/complete-invitation-form";

export default async function CompleteInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <CompleteInvitationForm token={token} />;
}
