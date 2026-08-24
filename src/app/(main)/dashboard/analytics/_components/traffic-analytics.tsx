"use client";

import * as React from "react";

import { CalendarDays, Clock3, Database, Gauge, type LucideIcon, RefreshCw, Route, Shapes } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  HourlyActivityChart,
  LaneComparisonChart,
  TrafficVolumeChart,
  VehicleClassificationChart,
} from "./traffic-analytics-charts";
import {
  buildClassificationSeries,
  buildHourlyActivitySeries,
  buildTrafficMetrics,
  buildVolumeSeries,
  filterTrafficEvents,
  formatManilaDate,
  subscribeToTrafficEvents,
  type TrafficDataSource,
  type TrafficEvent,
  type TrafficNodeFilter,
  type TrafficRange,
} from "./traffic-analytics-data";
import { TrafficLogsTable } from "./traffic-logs-table";

const RANGE_LABELS: Record<TrafficRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const NODE_FILTER_LABELS: Record<TrafficNodeFilter, string> = {
  all: "All nodes",
  "node-a": "Node A",
  "node-b": "Node B",
};

const METRIC_SKELETON_KEYS = ["total", "busiest-node", "peak-hour", "top-class"] as const;

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums tracking-tight">{value}</CardTitle>
        <CardAction>
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </CardContent>
    </Card>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading traffic analytics" role="status">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {METRIC_SKELETON_KEYS.map((key) => (
          <Skeleton className="h-28" key={key} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Skeleton className="h-96 xl:col-span-8" />
        <Skeleton className="h-96 xl:col-span-4" />
        <Skeleton className="h-80 xl:col-span-7" />
        <Skeleton className="h-80 xl:col-span-5" />
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}

function isNodeFilter(value: string): value is TrafficNodeFilter {
  return value === "all" || value === "node-a" || value === "node-b";
}

function isTrafficRange(value: string): value is TrafficRange {
  return value === "24h" || value === "7d" || value === "30d";
}

export function TrafficAnalytics() {
  const [events, setEvents] = React.useState<TrafficEvent[]>([]);
  const [dataSource, setDataSource] = React.useState<TrafficDataSource>("sample");
  const [nodeFilter, setNodeFilter] = React.useState<TrafficNodeFilter>("all");
  const [range, setRange] = React.useState<TrafficRange>("7d");
  const [specificDate, setSpecificDate] = React.useState<Date>();
  const [datePickerOpen, setDatePickerOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    void refreshKey;
    setLoading(true);
    setError(null);

    return subscribeToTrafficEvents(
      (nextEvents, source) => {
        setEvents(nextEvents);
        setDataSource(source);
        setLoading(false);
      },
      (cause) => {
        setError(cause.message);
        setLoading(false);
      },
      { specificDate },
    );
  }, [refreshKey, specificDate]);

  const filteredEvents = React.useMemo(
    () => filterTrafficEvents(events, range, nodeFilter, new Date(), specificDate),
    [events, nodeFilter, range, specificDate],
  );
  const metrics = React.useMemo(() => buildTrafficMetrics(filteredEvents), [filteredEvents]);
  const volumeData = React.useMemo(
    () => buildVolumeSeries(filteredEvents, range, specificDate),
    [filteredEvents, range, specificDate],
  );
  const classificationData = React.useMemo(() => buildClassificationSeries(filteredEvents), [filteredEvents]);
  const hourlyData = React.useMemo(() => buildHourlyActivitySeries(filteredEvents), [filteredEvents]);
  const periodLabel = specificDate ? formatManilaDate(specificDate) : RANGE_LABELS[range];
  const isInitialLoading = loading && events.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl leading-none tracking-tight">Traffic Analytics</h1>
          <p className="text-muted-foreground text-sm">
            Historical lane volume, vehicle classification, and detection records from Firebase.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={dataSource === "firestore" ? "secondary" : "outline"}>
            <Database data-icon="inline-start" />
            {dataSource === "firestore" ? "Firestore live" : "Sample data"}
          </Badge>

          <ToggleGroup
            aria-label="Filter charts by traffic node"
            onValueChange={(value) => {
              if (isNodeFilter(value)) setNodeFilter(value);
            }}
            size="sm"
            spacing={0}
            type="single"
            value={nodeFilter}
            variant="outline"
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="node-a">A</ToggleGroupItem>
            <ToggleGroupItem value="node-b">B</ToggleGroupItem>
          </ToggleGroup>

          <Select
            value={range}
            onValueChange={(value) => {
              if (!isTrafficRange(value)) return;
              setRange(value);
              setSpecificDate(undefined);
            }}
          >
            <SelectTrigger aria-label="Select analytics date range" className="w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectGroup>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                aria-label={
                  specificDate
                    ? `Specific analytics date: ${periodLabel}. Open date picker`
                    : "Select a specific analytics date"
                }
                aria-pressed={specificDate !== undefined}
                className="w-40 justify-start"
                size="sm"
                variant={specificDate ? "secondary" : "outline"}
              >
                <CalendarDays data-icon="inline-start" />
                {specificDate ? periodLabel : "Specific date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto gap-0 p-0">
              <PopoverHeader className="px-3 pt-3 pb-1">
                <PopoverTitle>Specific date</PopoverTitle>
                <PopoverDescription>Filter analytics to one full day in Manila time.</PopoverDescription>
              </PopoverHeader>
              <Calendar
                captionLayout="dropdown"
                disabled={{ after: new Date() }}
                mode="single"
                onSelect={(selectedDate) => {
                  if (!selectedDate) return;
                  setSpecificDate(selectedDate);
                  setDatePickerOpen(false);
                }}
                selected={specificDate}
                timeZone="Asia/Manila"
              />
              {specificDate ? (
                <>
                  <Separator />
                  <div className="p-2">
                    <Button
                      className="w-full"
                      onClick={() => {
                        setSpecificDate(undefined);
                        setDatePickerOpen(false);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Use {RANGE_LABELS[range]}
                    </Button>
                  </div>
                </>
              ) : null}
            </PopoverContent>
          </Popover>

          <Button
            aria-label="Refresh Firebase traffic data"
            disabled={loading}
            onClick={() => setRefreshKey((value) => value + 1)}
            size="icon-sm"
            variant="outline"
          >
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <Database />
          <AlertTitle>Firebase history is unavailable</AlertTitle>
          <AlertDescription>
            {error} The dashboard is showing a local sample dataset until the connection recovers.
          </AlertDescription>
          <AlertAction>
            <Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" variant="outline">
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {isInitialLoading ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              detail={`${periodLabel} · ${NODE_FILTER_LABELS[nodeFilter]}`}
              icon={Gauge}
              title="Total vehicles"
              value={metrics.total.toLocaleString()}
            />
            <MetricCard
              detail={`${metrics.busiestNodeCount.toLocaleString()} recorded detections`}
              icon={Route}
              title="Busiest node"
              value={metrics.busiestNode}
            />
            <MetricCard
              detail={`${metrics.peakHourCount.toLocaleString()} vehicles in that hour`}
              icon={Clock3}
              title="Peak traffic hour"
              value={metrics.peakHour}
            />
            <MetricCard
              detail={`${metrics.topClassCount.toLocaleString()} classifications`}
              icon={Shapes}
              title="Most detected"
              value={metrics.topClass}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <TrafficVolumeChart data={volumeData} periodLabel={periodLabel} range={range} />
            </div>
            <div className="min-w-0 xl:col-span-4">
              <VehicleClassificationChart data={classificationData} />
            </div>
            <div className="min-w-0 xl:col-span-7">
              <LaneComparisonChart data={volumeData} />
            </div>
            <div className="min-w-0 xl:col-span-5">
              <HourlyActivityChart data={hourlyData} />
            </div>
          </div>

          <TrafficLogsTable
            dataSource={dataSource}
            events={filteredEvents}
            loading={loading}
            nodeFilter={nodeFilter}
            onNodeFilterChange={setNodeFilter}
            periodLabel={periodLabel}
          />
        </>
      )}
    </div>
  );
}
