"use client";

// Displays the live staff activity audit stream.

import * as React from "react";

import { ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import type { StaffActivityRecord } from "./staff-activity-data";

const columns = ["Login date", "Logout date", "Role", "Name", "Activity", "Timestamp"] as const;
const PAGE_SIZE = 7;

const dateFormatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

const timeFormatter = new Intl.DateTimeFormat("en-PH", {
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

function formatDate(value?: Date) {
  return value ? dateFormatter.format(value) : "--";
}

function formatTime(value: Date) {
  return timeFormatter.format(value);
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
  const [page, setPage] = React.useState(0);
  const pageCount = Math.max(1, Math.ceil(activities.length / PAGE_SIZE));
  const pageActivities = activities.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  React.useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1));
  }, [pageCount]);

  const firstVisible = activities.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastVisible = Math.min((page + 1) * PAGE_SIZE, activities.length);

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
              pageActivities.map((activity) => (
                <TableRow key={activity.id}>
                  <TableCell className="px-4">{formatDate(activity.loginAt)}</TableCell>
                  <TableCell className="px-4">{formatDate(activity.logoutAt)}</TableCell>
                  <TableCell className="px-4">{activity.role}</TableCell>
                  <TableCell className="px-4 font-medium">{activity.name}</TableCell>
                  <TableCell className="px-4">{activity.activity}</TableCell>
                  <TableCell className="px-4">{formatTime(activity.occurredAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {activities.length > 0 ? (
          <div className="flex items-center justify-between border-t px-4 py-3 text-muted-foreground text-sm">
            <span>
              Showing {firstVisible}–{lastVisible} of {activities.length} events
            </span>
            <div className="flex items-center gap-1">
              <Button
                aria-label="Previous staff activity page"
                disabled={page === 0}
                onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-14 text-center">
                {page + 1} / {pageCount}
              </span>
              <Button
                aria-label="Next staff activity page"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((currentPage) => Math.min(pageCount - 1, currentPage + 1))}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
