import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-3xl leading-none tracking-tight">System Logs</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Operational events from the local system and telemetry store.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Event History</CardTitle>
          <CardDescription>No production events are synthesized.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {["Timestamp", "Event", "Lane / Node", "Vehicle Count", "Signal", "Power Source", "Status"].map(
                  (item) => (
                    <TableHead key={item}>{item}</TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody />
          </Table>
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyTitle>No system logs yet</EmptyTitle>
              <EmptyDescription>
                Connect Firebase Realtime Database or a backend event source to populate this table.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}
