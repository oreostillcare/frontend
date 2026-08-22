import { AccountPanel } from "./_components/account-panel";
export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl leading-none tracking-tight">Account</h1>
      <AccountPanel />
    </div>
  );
}
