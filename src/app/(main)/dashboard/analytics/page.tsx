import { BarChart3 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

const panels = [
  "Vehicle Count Over Time",
  "Vehicle Classification Distribution",
  "Lane Comparison",
  "Hourly Traffic Activity",
];

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-3xl leading-none tracking-tight">Traffic Analytics</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Lane comparison, classification, and hourly activity from stored telemetry.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {panels.map((title) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
              <CardDescription>Waiting for historical Firebase telemetry</CardDescription>
            </CardHeader>
            <CardContent>
              <Empty className="min-h-52">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BarChart3 />
                  </EmptyMedia>
                  <EmptyTitle>No analytics data yet</EmptyTitle>
                  <EmptyDescription>
                    Charts will populate when a Realtime Database URL and stored history are available.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
