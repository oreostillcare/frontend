"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { format } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, Search, SearchX } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import type { DropdownProps } from "react-day-picker";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { auth } from "@/lib/firebase/client";

function CalendarDropdown({ options, value, onChange, disabled, ...props }: DropdownProps) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(nextValue) => onChange?.({ target: { value: nextValue } } as ChangeEvent<HTMLSelectElement>)}
      value={String(value ?? "")}
    >
      <SelectTrigger aria-label={props["aria-label"]} className="h-7 w-auto min-w-16 border-0 bg-transparent px-1 text-xs shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options?.map((option) => (
          <SelectItem disabled={option.disabled} key={option.value} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type NodeId = "Node A" | "Node B";
type SessionEvent = "Origin position confirmed" | "Retrieved" | "Compromised";
type SessionStatus = "Active" | "Compromised" | "Completed";

type SessionLog = {
  actor: string;
  event: SessionEvent;
  id: string;
  node: NodeId;
  originLocation: string;
  retrievedLocation: string | null;
  status: SessionStatus;
  timestamp: string;
  timestampLabel: string;
};

function timestampToDate(value: unknown) {
  if (typeof value === "string") return new Date(value);
  return null;
}

function manilaDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Manila",
    year: "numeric",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function mapFirestoreLog(id: string, data: Record<string, unknown>): SessionLog | null {
  const node = data.node === "Node A" || data.node === "Node B" ? data.node : null;
  const event =
    data.event === "Origin position confirmed" || data.event === "Retrieved" || data.event === "Compromised"
      ? data.event
      : null;
  const status = data.status === "Active" || data.status === "Compromised" || data.status === "Completed" ? data.status : null;
  const occurredAt = timestampToDate(data.occurredAt);
  if (!node || !event || !status || !occurredAt) return null;

  return {
    actor: typeof data.actor === "string" ? data.actor : "System",
    event,
    id,
    node,
    originLocation: typeof data.originLocation === "string" ? data.originLocation : "--",
    retrievedLocation: typeof data.retrievedLocation === "string" ? data.retrievedLocation : null,
    status,
    timestamp: occurredAt.toISOString(),
    timestampLabel: occurredAt.toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }),
  };
}

const originLocations: Record<NodeId, string> = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94098, 121.16204)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94188, 121.16442)",
};

const retrievedLocations: Record<NodeId, string> = {
  "Node A": "C.M. Recto Avenue, Lipa City (13.94112, 121.16230)",
  "Node B": "C.M. Recto Avenue, Lipa City (13.94190, 121.16430)",
};

function createCompletedMockSession(
  id: string,
  originA: string,
  originB: string,
  retrievedA: string,
  retrievedB: string,
) {
  const rows = [
    { event: "Origin position confirmed" as const, node: "Node A" as const, timestamp: originA, status: "Active" as const },
    { event: "Origin position confirmed" as const, node: "Node B" as const, timestamp: originB, status: "Active" as const },
    { event: "Retrieved" as const, node: "Node A" as const, timestamp: retrievedA, status: "Completed" as const },
    { event: "Retrieved" as const, node: "Node B" as const, timestamp: retrievedB, status: "Completed" as const },
  ];

  return rows.map((row) => ({
    actor: "Administrator",
    event: row.event,
    id: `${id}-${row.node}-${row.event}`,
    node: row.node,
    originLocation: originLocations[row.node],
    retrievedLocation: row.event === "Retrieved" ? originLocations[row.node] : null,
    status: row.status,
    timestamp: row.timestamp,
    timestampLabel: new Date(row.timestamp).toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }),
  }));
}

const mockSessionLogs: SessionLog[] = [
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-11T08:15:00+08:00",
    timestampLabel: "Nov 11, 2026 - 8:15 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-11T08:10:00+08:00",
    timestampLabel: "Nov 11, 2026 - 8:10 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-11",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: originLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-11T12:15:00+08:00",
    timestampLabel: "Nov 11, 2026 - 12:15 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-11",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-11T12:20:00+08:00",
    timestampLabel: "Nov 11, 2026 - 12:20 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-1",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: originLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-01T12:15:00+08:00",
    timestampLabel: "Nov 1, 2026 - 12:15 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-1",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-01T12:20:00+08:00",
    timestampLabel: "Nov 1, 2026 - 12:20 PM",
  },
  {
    actor: "Warning system",
    event: "Compromised",
    id: "compromised-b",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Compromised",
    timestamp: "2026-11-03T14:05:00+08:00",
    timestampLabel: "Nov 3, 2026 - 2:05 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: originLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-05T16:00:00+08:00",
    timestampLabel: "Nov 5, 2026 - 4:00 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-04T10:30:00+08:00",
    timestampLabel: "Nov 4, 2026 - 10:30 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-1",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-01T08:15:00+08:00",
    timestampLabel: "Nov 1, 2026 - 8:15 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-1",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-01T08:20:00+08:00",
    timestampLabel: "Nov 1, 2026 - 8:20 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-2",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-02T07:45:00+08:00",
    timestampLabel: "Nov 2, 2026 - 7:45 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-2",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-02T07:50:00+08:00",
    timestampLabel: "Nov 2, 2026 - 7:50 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-3",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-03T08:00:00+08:00",
    timestampLabel: "Nov 3, 2026 - 8:00 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-3",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-03T08:05:00+08:00",
    timestampLabel: "Nov 3, 2026 - 8:05 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-3",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: retrievedLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-03T13:00:00+08:00",
    timestampLabel: "Nov 3, 2026 - 1:00 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-3",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: originLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-03T13:30:00+08:00",
    timestampLabel: "Nov 3, 2026 - 1:30 PM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-4",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-04T07:45:00+08:00",
    timestampLabel: "Nov 4, 2026 - 7:45 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-4",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-04T07:50:00+08:00",
    timestampLabel: "Nov 4, 2026 - 7:50 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-4",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: retrievedLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-04T12:00:00+08:00",
    timestampLabel: "Nov 4, 2026 - 12:00 PM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-5",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-05T08:10:00+08:00",
    timestampLabel: "Nov 5, 2026 - 8:10 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-5",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-05T08:15:00+08:00",
    timestampLabel: "Nov 5, 2026 - 8:15 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-5",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-05T16:30:00+08:00",
    timestampLabel: "Nov 5, 2026 - 4:30 PM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-a-nov-6",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-06T07:30:00+08:00",
    timestampLabel: "Nov 6, 2026 - 7:30 AM",
  },
  {
    actor: "Administrator",
    event: "Origin position confirmed",
    id: "origin-b-nov-6",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: null,
    status: "Active",
    timestamp: "2026-11-06T07:35:00+08:00",
    timestampLabel: "Nov 6, 2026 - 7:35 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-6",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: originLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-06T11:45:00+08:00",
    timestampLabel: "Nov 6, 2026 - 11:45 AM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-6",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-06T12:00:00+08:00",
    timestampLabel: "Nov 6, 2026 - 12:00 PM",
  },
  {
    actor: "Warning system",
    event: "Compromised",
    id: "compromised-a-nov-2",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: null,
    status: "Compromised",
    timestamp: "2026-11-02T13:10:00+08:00",
    timestampLabel: "Nov 2, 2026 - 1:10 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-a-nov-2",
    node: "Node A",
    originLocation: originLocations["Node A"],
    retrievedLocation: retrievedLocations["Node A"],
    status: "Completed",
    timestamp: "2026-11-02T15:30:00+08:00",
    timestampLabel: "Nov 2, 2026 - 3:30 PM",
  },
  {
    actor: "Administrator",
    event: "Retrieved",
    id: "retrieve-b-nov-2",
    node: "Node B",
    originLocation: originLocations["Node B"],
    retrievedLocation: originLocations["Node B"],
    status: "Completed",
    timestamp: "2026-11-02T16:00:00+08:00",
    timestampLabel: "Nov 2, 2026 - 4:00 PM",
  },
  ...createCompletedMockSession(
    "nov-7-morning",
    "2026-11-07T07:00:00+08:00",
    "2026-11-07T07:05:00+08:00",
    "2026-11-07T10:50:00+08:00",
    "2026-11-07T11:00:00+08:00",
  ),
  ...createCompletedMockSession(
    "nov-7-afternoon",
    "2026-11-07T14:00:00+08:00",
    "2026-11-07T14:05:00+08:00",
    "2026-11-07T18:50:00+08:00",
    "2026-11-07T19:00:00+08:00",
  ),
];

const PAGE_SIZE = 5;
const FILTER_NOW = new Date("2026-11-11T23:59:59+08:00").getTime();

export function SessionLogs() {
  const [logs, setLogs] = useState<SessionLog[]>(mockSessionLogs);
  const [query, setQuery] = useState("");
  const [nodeFilter, setNodeFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("7");
  const [selectedDate, setSelectedDate] = useState(() => manilaDateKey(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!auth) return;

    let cancelled = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) return;

      void user
        .getIdToken()
        .then((token) => fetch("/api/node-session-logs", { headers: { Authorization: `Bearer ${token}` } }))
        .then(async (response) => {
          if (!response.ok) throw new Error("Session logs request failed.");
          return (await response.json()) as { logs?: Array<Record<string, unknown>> };
        })
        .then((payload) => {
          if (cancelled) return;
          const serverLogs = (payload.logs ?? [])
            .map((log) => mapFirestoreLog(String(log.id ?? ""), log))
            .filter((log): log is SessionLog => Boolean(log));
          setLogs(serverLogs.length ? serverLogs : mockSessionLogs);
        })
        .catch(() => {
          if (!cancelled) setLogs(mockSessionLogs);
        });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const filteredLogs = useMemo(() => {
    const minimumTimestamp = timeFilter === "all" ? 0 : FILTER_NOW - Number(timeFilter) * 24 * 60 * 60 * 1000;

    return logs.filter((log) => {
      const searchableText = `${log.event} ${log.node} ${log.originLocation} ${log.retrievedLocation ?? ""} ${log.status}`;
      const matchesQuery = searchableText.toLowerCase().includes(query.toLowerCase());
      const matchesNode = nodeFilter === "all" || log.node === nodeFilter;
      const matchesTime =
        timeFilter === "date"
          ? manilaDateKey(new Date(log.timestamp)) === selectedDate
          : new Date(log.timestamp).getTime() >= minimumTimestamp;
      return matchesQuery && matchesNode && matchesTime;
    });
  }, [logs, nodeFilter, query, selectedDate, timeFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount);
  const pageLogs = filteredLogs.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [nodeFilter, query, selectedDate, timeFilter]);

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Session Logs</CardTitle>
            <CardDescription>Review origin, retrieval, and compromised-node events.</CardDescription>
          </div>
          <Badge variant="secondary">{filteredLogs.length} events</Badge>
        </div>
        <div className="flex flex-col gap-2 pt-3 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search session logs"
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search event or node"
              value={query}
            />
          </div>
          <Select onValueChange={setNodeFilter} value={nodeFilter}>
            <SelectTrigger aria-label="Filter by node" className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All nodes</SelectItem>
              <SelectItem value="Node A">Node A</SelectItem>
              <SelectItem value="Node B">Node B</SelectItem>
            </SelectContent>
          </Select>
          <Select onValueChange={setTimeFilter} value={timeFilter}>
            <SelectTrigger aria-label="Filter by time range" className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="date">Select date</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          {timeFilter === "date" && (
            <Popover modal={false} open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-label="Select session log date"
                  className="w-full justify-start font-normal lg:w-44"
                  size="sm"
                  variant="outline"
                >
                  <CalendarDays data-icon="inline-start" />
                  {format(new Date(`${selectedDate}T00:00:00`), "MMM d, yyyy")}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto p-0"
                onInteractOutside={(event) => {
                  const target = event.target;
                  if (target instanceof HTMLElement && target.closest('[data-slot="select-content"]')) {
                    event.preventDefault();
                  }
                }}
              >
                <Calendar
                  captionLayout="dropdown"
                  components={{ Dropdown: CalendarDropdown }}
                  mode="single"
                  onSelect={(date) => {
                    if (!date) return;
                    setSelectedDate(format(date, "yyyy-MM-dd"));
                    setDatePickerOpen(false);
                  }}
                  selected={new Date(`${selectedDate}T00:00:00`)}
                  timeZone="Asia/Manila"
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Node</TableHead>
              <TableHead>Origin Location</TableHead>
              <TableHead>Retrieved Location</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>User / Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageLogs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-muted-foreground">{log.timestampLabel}</TableCell>
                <TableCell>{log.event}</TableCell>
                <TableCell>{log.node}</TableCell>
                <TableCell className="max-w-72 whitespace-normal">{log.originLocation}</TableCell>
                <TableCell className="max-w-72 whitespace-normal">{log.retrievedLocation ?? "--"}</TableCell>
                <TableCell>{log.status}</TableCell>
                <TableCell>{log.actor}</TableCell>
              </TableRow>
            ))}
            {!pageLogs.length && (
              <TableRow>
                <TableCell className="h-56 text-center" colSpan={7}>
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <SearchX className="size-8" />
                    <p className="font-medium text-foreground">No matching session logs</p>
                    <p>Try another node, time range, or search phrase.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3 border-t p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            Showing {filteredLogs.length ? (visiblePage - 1) * PAGE_SIZE + 1 : 0}-
            {Math.min(visiblePage * PAGE_SIZE, filteredLogs.length)} of {filteredLogs.length} events
          </span>
          <div className="flex items-center gap-2">
            <button
              aria-label="Previous page"
              className="rounded-md p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
              disabled={visiblePage === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-8 rounded-md border px-2 py-1 text-center text-foreground">{visiblePage}</span>
            <button
              aria-label="Next page"
              className="rounded-md p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
              disabled={visiblePage === pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              type="button"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
