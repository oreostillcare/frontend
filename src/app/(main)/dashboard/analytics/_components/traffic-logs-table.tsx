"use client";

import { type ChangeEvent, type MouseEvent, useMemo, useState } from "react";

import { Search, SearchX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
  formatVehicleClass,
  type TrafficDataSource,
  type TrafficEvent,
  type TrafficNodeFilter,
} from "./traffic-analytics-data";

const ROWS_PER_PAGE = 8;
const SKELETON_ROWS = 6;

const nodeLabels = {
  all: "All nodes",
  "node-a": "Node A",
  "node-b": "Node B",
} satisfies Record<TrafficNodeFilter, string>;

const sourceDetails = {
  firestore: { label: "Firebase", variant: "secondary" },
  sample: { label: "Sample data", variant: "outline" },
} as const satisfies Record<TrafficDataSource, { label: string; variant: "outline" | "secondary" }>;

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

function getPageNumbers(currentPage: number, pageCount: number) {
  if (pageCount <= 3) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  if (currentPage <= 2) return [1, 2, 3];
  if (currentPage >= pageCount - 1) return [pageCount - 2, pageCount - 1, pageCount];

  return [currentPage - 1, currentPage, currentPage + 1];
}

function isTrafficNodeFilter(value: string): value is TrafficNodeFilter {
  return value === "all" || value === "node-a" || value === "node-b";
}

function formatConfidence(confidence: number | null) {
  return confidence === null ? "Unavailable" : `${Math.round(confidence * 100)}%`;
}

interface TrafficLogsTableProps {
  events: TrafficEvent[];
  loading: boolean;
  dataSource: TrafficDataSource;
  nodeFilter: TrafficNodeFilter;
  onNodeFilterChange: (value: TrafficNodeFilter) => void;
  periodLabel: string;
}

export function TrafficLogsTable({
  events,
  loading,
  dataSource,
  nodeFilter,
  onNodeFilterChange,
  periodLabel,
}: TrafficLogsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [requestedPage, setRequestedPage] = useState(1);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return [...events]
      .sort((first, second) => second.occurredAt.getTime() - first.occurredAt.getTime())
      .filter((event) => nodeFilter === "all" || event.nodeId === nodeFilter)
      .filter((event) => {
        if (!normalizedQuery) return true;

        const searchableValues = [
          formatVehicleClass(event.vehicleClass),
          event.vehicleClass,
          event.vehicleId,
          nodeLabels[event.nodeId],
          event.laneId,
          dateFormatter.format(event.occurredAt),
          timeFormatter.format(event.occurredAt),
          event.direction ?? "",
        ];

        return searchableValues.some((value) => value.toLowerCase().includes(normalizedQuery));
      });
  }, [events, nodeFilter, searchQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / ROWS_PER_PAGE));
  const currentPage = Math.min(requestedPage, pageCount);
  const pageNumbers = getPageNumbers(currentPage, pageCount);
  const firstRowIndex = (currentPage - 1) * ROWS_PER_PAGE;
  const visibleEvents = filteredEvents.slice(firstRowIndex, firstRowIndex + ROWS_PER_PAGE);
  const firstVisibleRow = filteredEvents.length === 0 ? 0 : firstRowIndex + 1;
  const lastVisibleRow = Math.min(firstRowIndex + ROWS_PER_PAGE, filteredEvents.length);
  const canGoBack = currentPage > 1;
  const canGoForward = currentPage < pageCount;
  const source = sourceDetails[dataSource];
  const hasActiveFilters = nodeFilter !== "all" || searchQuery.trim().length > 0;

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
    setRequestedPage(1);
  };

  const handleNodeChange = (value: string) => {
    if (!isTrafficNodeFilter(value)) return;
    onNodeFilterChange(value);
    setRequestedPage(1);
  };

  const handlePagination = (event: MouseEvent<HTMLAnchorElement>, page: number) => {
    event.preventDefault();
    setRequestedPage(Math.min(Math.max(page, 1), pageCount));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traffic Logs</CardTitle>
        <CardDescription>Review detections by node and lane for {periodLabel}.</CardDescription>
        <CardAction>
          <Badge variant={source.variant}>{source.label}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-0">
        <div className="flex flex-col gap-2 px-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <label className="sr-only" htmlFor="traffic-node-filter">
              Filter traffic logs by node
            </label>
            <Select value={nodeFilter} onValueChange={handleNodeChange}>
              <SelectTrigger id="traffic-node-filter" className="w-full sm:w-40" aria-label="Filter by node">
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value="all">All nodes</SelectItem>
                  <SelectItem value="node-a">Node A</SelectItem>
                  <SelectItem value="node-b">Node B</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="w-full sm:max-w-72">
            <label className="sr-only" htmlFor="traffic-log-search">
              Search traffic logs
            </label>
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="traffic-log-search"
                type="search"
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder="Search class or vehicle ID"
                autoComplete="off"
              />
            </InputGroup>
          </div>
        </div>

        <Table id="traffic-logs-table" aria-label="Traffic detection logs">
          <TableHeader className="border-t">
            <TableRow>
              <TableHead className="pl-4">Classification</TableHead>
              <TableHead>Vehicle ID</TableHead>
              <TableHead>Node / Lane</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="pr-4 text-right">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:py-3 [&_tr]:border-border/50">
            {loading
              ? Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
                  <TableRow key={`traffic-log-skeleton-${rowIndex}`} aria-hidden="true">
                    {Array.from({ length: 6 }, (_, cellIndex) => (
                      <TableCell
                        key={`traffic-log-skeleton-${rowIndex}-${cellIndex}`}
                        className={cn(cellIndex === 0 && "pl-4", cellIndex === 5 && "pr-4")}
                      >
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : visibleEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="pl-4">
                      <Badge variant="secondary">{formatVehicleClass(event.vehicleClass)}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">{event.vehicleId}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span>{nodeLabels[event.nodeId]}</span>
                        <span className="text-muted-foreground text-xs">{event.laneId}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <time dateTime={event.occurredAt.toISOString()}>{dateFormatter.format(event.occurredAt)}</time>
                    </TableCell>
                    <TableCell>
                      <time dateTime={event.occurredAt.toISOString()}>{timeFormatter.format(event.occurredAt)}</time>
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{formatConfidence(event.confidence)}</TableCell>
                  </TableRow>
                ))}

            {!loading && visibleEvents.length === 0 ? (
              <TableRow>
                <TableCell className="whitespace-normal" colSpan={6}>
                  <Empty className="min-h-44">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <SearchX />
                      </EmptyMedia>
                      <EmptyTitle>
                        {hasActiveFilters ? "No matching traffic logs" : "No traffic logs for this period"}
                      </EmptyTitle>
                      <EmptyDescription>
                        {hasActiveFilters
                          ? "Try another node or clear the search to see more detections."
                          : `No detections were recorded for ${periodLabel}.`}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>

      <CardFooter className="flex-col gap-3 sm:flex-row sm:justify-between">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {loading
            ? "Loading traffic logs..."
            : `Showing ${firstVisibleRow}-${lastVisibleRow} of ${filteredEvents.length} events`}
        </p>

        <Pagination className="mx-0 w-auto" aria-label="Traffic log pagination">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#traffic-logs-table"
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
                  href="#traffic-logs-table"
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
                href="#traffic-logs-table"
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
  );
}
