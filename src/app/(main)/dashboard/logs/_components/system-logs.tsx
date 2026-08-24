"use client";

import { type ChangeEvent, type MouseEvent, useEffect, useMemo, useState } from "react";

import { AlertTriangle, CircleCheck, Database, RefreshCw, Search, SearchX, ServerOff } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  type SystemEvent,
  type SystemEventSeverity,
  type SystemEventStatus,
  subscribeToSystemEvents,
} from "./system-logs-data";

type SeverityFilter = "all" | SystemEventSeverity;
type NodeFilter = "all" | "node-a" | "node-b" | "system";
type RangeFilter = "24h" | "30d" | "7d" | "all";

const ROWS_PER_PAGE = 10;
const SKELETON_ROW_IDS = Array.from({ length: 6 }, (_, index) => `system-log-skeleton-${index + 1}`);
const SKELETON_COLUMNS = [
  { id: "timestamp", className: "pl-4" },
  { id: "severity", className: undefined },
  { id: "event", className: undefined },
  { id: "location", className: undefined },
  { id: "vehicle-count", className: undefined },
  { id: "signal", className: undefined },
  { id: "power-source", className: undefined },
  { id: "status", className: "pr-4" },
] as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const dateFormatter = new Intl.DateTimeFormat("en-PH", {
  day: "2-digit",
  month: "short",
  timeZone: "Asia/Manila",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-PH", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Manila",
});

const shortDateTimeFormatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

const nodeLabels: Record<string, string> = {
  "node-a": "Node A",
  "node-b": "Node B",
  system: "System",
};

const severityVariants = {
  critical: "destructive",
  info: "outline",
  warning: "secondary",
} as const satisfies Record<SystemEventSeverity, "destructive" | "outline" | "secondary">;

const statusVariants = {
  active: "destructive",
  observed: "outline",
  resolved: "secondary",
} as const satisfies Record<SystemEventStatus, "destructive" | "outline" | "secondary">;

const signalVariants = {
  GREEN: "secondary",
  RED: "destructive",
  UNKNOWN: "outline",
} as const;

function formatLabel(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function getPageNumbers(currentPage: number, pageCount: number) {
  if (pageCount <= 3) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (currentPage <= 2) return [1, 2, 3];
  if (currentPage >= pageCount - 1) return [pageCount - 2, pageCount - 1, pageCount];
  return [currentPage - 1, currentPage, currentPage + 1];
}

function rangeStart(range: RangeFilter) {
  const now = Date.now();
  if (range === "24h") return now - DAY_MS;
  if (range === "7d") return now - 7 * DAY_MS;
  if (range === "30d") return now - 30 * DAY_MS;
  return Number.NEGATIVE_INFINITY;
}

function isSeverityFilter(value: string): value is SeverityFilter {
  return value === "all" || value === "info" || value === "warning" || value === "critical";
}

function isNodeFilter(value: string): value is NodeFilter {
  return value === "all" || value === "node-a" || value === "node-b" || value === "system";
}

function isRangeFilter(value: string): value is RangeFilter {
  return value === "24h" || value === "7d" || value === "30d" || value === "all";
}

function getConnectionLabel(error: string | null, loading: boolean) {
  if (error) return "Firestore unavailable";
  if (loading) return "Connecting...";
  return "Firestore live";
}

function getEmptyState(error: string | null, hasActiveFilters: boolean) {
  if (error) {
    return {
      description: "Restore the Firebase connection or permissions, then use Retry above.",
      title: "System logs unavailable",
    };
  }

  if (hasActiveFilters) {
    return {
      description: "Try another node, severity, time range, or search phrase.",
      title: "No matching system logs",
    };
  }

  return {
    description: "Hardware state changes written to Firestore will appear here automatically.",
    title: "No system logs yet",
  };
}

function SystemMetricCard({
  description,
  icon: Icon,
  loading,
  title,
  value,
}: {
  description: string;
  icon: typeof Database;
  loading: boolean;
  title: string;
  value: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {loading ? <Skeleton className="h-7 w-16" /> : <p className="font-heading text-2xl tabular-nums">{value}</p>}
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

export function SystemLogs() {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [nodeFilter, setNodeFilter] = useState<NodeFilter>("all");
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>("7d");
  const [requestedPage, setRequestedPage] = useState(1);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);

  useEffect(() => {
    return subscribeToSystemEvents(
      (nextEvents) => {
        setEvents(nextEvents);
        setError(null);
        setLoading(false);
      },
      (subscriptionError) => {
        setError(subscriptionError.message || `System log subscription attempt ${subscriptionVersion + 1} failed.`);
        setLoading(false);
      },
    );
  }, [subscriptionVersion]);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const earliestTimestamp = rangeStart(rangeFilter);

    return events.filter((event) => {
      if (event.occurredAt.getTime() < earliestTimestamp) return false;
      if (severityFilter !== "all" && event.severity !== severityFilter) return false;
      if (nodeFilter !== "all" && event.nodeId !== nodeFilter) return false;
      if (!normalizedQuery) return true;

      const searchableValues = [
        event.message,
        event.eventType,
        event.category,
        event.component,
        nodeLabels[event.nodeId] ?? event.nodeId,
        event.laneId ?? "",
        event.powerSource ?? "",
        event.signal ?? "",
      ];
      return searchableValues.some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [events, nodeFilter, rangeFilter, searchQuery, severityFilter]);

  const metrics = useMemo(() => {
    const activeAlerts = events.filter(
      (event) => event.eventStatus === "active" && (event.severity === "critical" || event.severity === "warning"),
    );
    const criticalEvents = events.filter((event) => event.severity === "critical");
    const resolvedEvents = events.filter((event) => event.eventStatus === "resolved");

    return {
      activeAlerts: activeAlerts.length,
      criticalEvents: criticalEvents.length,
      lastEvent: events.at(0)?.occurredAt,
      resolvedEvents: resolvedEvents.length,
    };
  }, [events]);

  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / ROWS_PER_PAGE));
  const currentPage = Math.min(requestedPage, pageCount);
  const firstRowIndex = (currentPage - 1) * ROWS_PER_PAGE;
  const visibleEvents = filteredEvents.slice(firstRowIndex, firstRowIndex + ROWS_PER_PAGE);
  const pageNumbers = getPageNumbers(currentPage, pageCount);
  const firstVisibleRow = filteredEvents.length === 0 ? 0 : firstRowIndex + 1;
  const lastVisibleRow = Math.min(firstRowIndex + ROWS_PER_PAGE, filteredEvents.length);
  const canGoBack = currentPage > 1;
  const canGoForward = currentPage < pageCount;
  const hasActiveFilters =
    events.length > 0 &&
    (searchQuery.trim().length > 0 || severityFilter !== "all" || nodeFilter !== "all" || rangeFilter !== "all");
  const connectionLabel = getConnectionLabel(error, loading);
  const emptyState = getEmptyState(error, hasActiveFilters);

  const resetPage = () => setRequestedPage(1);

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
    resetPage();
  };

  const handleSeverityChange = (value: string) => {
    if (!isSeverityFilter(value)) return;
    setSeverityFilter(value);
    resetPage();
  };

  const handleNodeChange = (value: string) => {
    if (!isNodeFilter(value)) return;
    setNodeFilter(value);
    resetPage();
  };

  const handleRangeChange = (value: string) => {
    if (!isRangeFilter(value)) return;
    setRangeFilter(value);
    resetPage();
  };

  const handlePagination = (event: MouseEvent<HTMLAnchorElement>, page: number) => {
    event.preventDefault();
    setRequestedPage(Math.min(Math.max(page, 1), pageCount));
  };

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    setSubscriptionVersion((version) => version + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl leading-none tracking-tight">System Logs</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Hardware, power, camera, detector, and node events stored in Cloud Firestore.
          </p>
        </div>
        <Badge variant={error ? "destructive" : "outline"}>
          <Database aria-hidden="true" />
          {connectionLabel}
        </Badge>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>System logs could not be loaded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="sm" onClick={handleRetry}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SystemMetricCard
          title="Active alerts"
          value={error && events.length === 0 ? "--" : String(metrics.activeAlerts)}
          description="Open issues in loaded history"
          icon={AlertTriangle}
          loading={loading}
        />
        <SystemMetricCard
          title="Critical events"
          value={error && events.length === 0 ? "--" : String(metrics.criticalEvents)}
          description="Within the latest 250 events"
          icon={ServerOff}
          loading={loading}
        />
        <SystemMetricCard
          title="Resolved events"
          value={error && events.length === 0 ? "--" : String(metrics.resolvedEvents)}
          description="Issues closed in loaded history"
          icon={CircleCheck}
          loading={loading}
        />
        <SystemMetricCard
          title="Latest event"
          value={metrics.lastEvent ? timeFormatter.format(metrics.lastEvent) : "--"}
          description={metrics.lastEvent ? dateFormatter.format(metrics.lastEvent) : "Waiting for telemetry"}
          icon={Database}
          loading={loading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Event History</CardTitle>
          <CardDescription>Review the latest 250 state changes reported by the traffic system.</CardDescription>
          <CardAction>
            <Badge variant="secondary">{events.length} events</Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 px-0">
          <div className="grid gap-2 px-4 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem]">
            <div>
              <label className="sr-only" htmlFor="system-log-search">
                Search system logs
              </label>
              <InputGroup>
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="system-log-search"
                  type="search"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  placeholder="Search event or component"
                  autoComplete="off"
                />
              </InputGroup>
            </div>

            <div>
              <label className="sr-only" htmlFor="system-log-node-filter">
                Filter system logs by node
              </label>
              <Select value={nodeFilter} onValueChange={handleNodeChange}>
                <SelectTrigger id="system-log-node-filter" className="w-full" aria-label="Filter by node">
                  <SelectValue placeholder="All nodes" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectGroup>
                    <SelectItem value="all">All nodes</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="node-a">Node A</SelectItem>
                    <SelectItem value="node-b">Node B</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="sr-only" htmlFor="system-log-severity-filter">
                Filter system logs by severity
              </label>
              <Select value={severityFilter} onValueChange={handleSeverityChange}>
                <SelectTrigger id="system-log-severity-filter" className="w-full" aria-label="Filter by severity">
                  <SelectValue placeholder="All severities" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectGroup>
                    <SelectItem value="all">All severities</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="sr-only" htmlFor="system-log-range-filter">
                Filter system logs by time range
              </label>
              <Select value={rangeFilter} onValueChange={handleRangeChange}>
                <SelectTrigger id="system-log-range-filter" className="w-full" aria-label="Filter by time range">
                  <SelectValue placeholder="Last 7 days" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    <SelectItem value="24h">Last 24 hours</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="30d">Last 30 days</SelectItem>
                    <SelectItem value="all">All loaded</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Table id="system-logs-table" aria-label="System hardware event history">
            <TableHeader className="border-t">
              <TableRow>
                <TableHead className="pl-4">Timestamp</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Lane / Node</TableHead>
                <TableHead>Vehicle Count</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Power Source</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:py-3 [&_tr]:border-border/50">
              {loading
                ? SKELETON_ROW_IDS.map((rowId) => (
                    <TableRow key={rowId} aria-hidden="true">
                      {SKELETON_COLUMNS.map((column) => (
                        <TableCell key={`${rowId}-${column.id}`} className={column.className}>
                          <Skeleton className="h-4 w-20" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : visibleEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="pl-4">
                        <time className="flex flex-col gap-0.5" dateTime={event.occurredAt.toISOString()}>
                          <span>{dateFormatter.format(event.occurredAt)}</span>
                          <span className="text-xs text-muted-foreground">
                            {timeFormatter.format(event.occurredAt)}
                          </span>
                        </time>
                      </TableCell>
                      <TableCell>
                        <Badge variant={severityVariants[event.severity]}>{formatLabel(event.severity)}</Badge>
                      </TableCell>
                      <TableCell className="max-w-80 whitespace-normal">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{event.message}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatLabel(event.component)} / {formatLabel(event.eventType)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span>{nodeLabels[event.nodeId] ?? formatLabel(event.nodeId)}</span>
                          <span className="text-xs text-muted-foreground">{event.laneId ?? "System-wide"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">{event.vehicleCount ?? "--"}</TableCell>
                      <TableCell>
                        {event.signal ? <Badge variant={signalVariants[event.signal]}>{event.signal}</Badge> : "--"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span>{event.powerSource ?? "--"}</span>
                          {event.batteryPercent !== undefined ? (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              Battery {Math.round(event.batteryPercent)}%
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="pr-4">
                        <Badge variant={statusVariants[event.eventStatus]}>{formatLabel(event.eventStatus)}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}

              {!loading && visibleEvents.length === 0 ? (
                <TableRow>
                  <TableCell className="whitespace-normal" colSpan={8}>
                    <Empty className="min-h-48">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <SearchX />
                        </EmptyMedia>
                        <EmptyTitle>{emptyState.title}</EmptyTitle>
                        <EmptyDescription>{emptyState.description}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>

        <CardFooter className="flex-col gap-3 sm:flex-row sm:justify-between">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {loading
              ? "Loading system logs..."
              : `Showing ${firstVisibleRow}-${lastVisibleRow} of ${filteredEvents.length} events`}
          </p>

          <Pagination className="mx-0 w-auto" aria-label="System log pagination">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#system-logs-table"
                  aria-disabled={!canGoBack}
                  tabIndex={canGoBack ? undefined : -1}
                  className={cn(!canGoBack && "pointer-events-none opacity-50")}
                  onClick={(event) => handlePagination(event, currentPage - 1)}
                />
              </PaginationItem>

              {pageNumbers[0] > 1 ? (
                <PaginationItem>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}

              {pageNumbers.map((pageNumber) => (
                <PaginationItem key={pageNumber}>
                  <PaginationLink
                    href="#system-logs-table"
                    aria-label={`Go to page ${pageNumber}`}
                    isActive={pageNumber === currentPage}
                    onClick={(event) => handlePagination(event, pageNumber)}
                  >
                    {pageNumber}
                  </PaginationLink>
                </PaginationItem>
              ))}

              {pageNumbers.at(-1) !== pageCount ? (
                <PaginationItem>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}

              <PaginationItem>
                <PaginationNext
                  href="#system-logs-table"
                  aria-disabled={!canGoForward}
                  tabIndex={canGoForward ? undefined : -1}
                  className={cn(!canGoForward && "pointer-events-none opacity-50")}
                  onClick={(event) => handlePagination(event, currentPage + 1)}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </CardFooter>
      </Card>

      {!loading && metrics.lastEvent ? (
        <p className="text-right text-xs text-muted-foreground">
          Latest Firestore event: {shortDateTimeFormatter.format(metrics.lastEvent)}
        </p>
      ) : null}
    </div>
  );
}
