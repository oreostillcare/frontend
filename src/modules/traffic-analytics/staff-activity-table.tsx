"use client";

// Displays the live staff activity audit stream.

import { ClipboardList } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import type { StaffActivityRecord } from "./staff-activity-data";

const columns = ["Login date", "Logout date", "Role", "Name", "Activity"] as const;

const dateFormatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

function formatDate(value?: Date) {
  return value ? dateFormatter.format(value) : "--";
}

export function StaffActivityTable({
  activities,
  error,
  loading,
}: {
  activities: StaffActivityRecord[];
  error: string | null;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff Activity</CardTitle>
        <CardDescription>Review staff sign-ins, sign-outs, and account actions.</CardDescription>
        <CardAction>
          <Badge variant="outline">{activities.length} events</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Staff activity logs">
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead className="px-4" key={column}>
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell className="p-0" colSpan={columns.length}>
                  <Empty className="min-h-64 rounded-none border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ClipboardList />
                      </EmptyMedia>
                      <EmptyTitle>Loading staff activity</EmptyTitle>
                      <EmptyDescription>Connecting to Firebase activity logs.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : activities.length === 0 ? (
              <TableRow>
                <TableCell className="p-0" colSpan={columns.length}>
                  <Empty className="min-h-64 rounded-none border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ClipboardList />
                      </EmptyMedia>
                      <EmptyTitle>{error ? "Unable to load staff activity" : "No staff activity yet"}</EmptyTitle>
                      <EmptyDescription>
                        {error ?? "Activity will appear here after staff sign in or make changes."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              activities.map((activity) => (
                <TableRow key={activity.id}>
                  <TableCell className="px-4">{formatDate(activity.loginAt)}</TableCell>
                  <TableCell className="px-4">{formatDate(activity.logoutAt)}</TableCell>
                  <TableCell className="px-4">{activity.role}</TableCell>
                  <TableCell className="px-4 font-medium">{activity.name}</TableCell>
                  <TableCell className="px-4">{activity.activity}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
