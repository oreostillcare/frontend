"use client";

// Composes traffic analytics controls, KPIs, charts, and transaction history.

import * as React from "react";

import { CalendarDays, Database, RefreshCw } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
  buildClassificationSeries,
  buildHourlyActivitySeries,
  buildVolumeSeries,
  filterTrafficEvents,
  formatManilaDate,
  subscribeToTrafficEvents,
  type TrafficDataSource,
  type TrafficEvent,
  type TrafficNodeFilter,
  type TrafficRange,
} from "./analytics-sample-data";
import {
  buildOperatingHoursSeries,
  filterStaffActivity,
  type OperatingHoursStaff,
  type StaffActivityRecord,
  type StaffRoleFilter,
  subscribeToStaffActivity,
} from "./staff-activity-data";
import { StaffActivityTable } from "./staff-activity-table";
import {
  HourlyActivityChart,
  LaneComparisonChart,
  OperatingHoursChart,
  TrafficVolumeChart,
  VehicleClassificationChart,
} from "./traffic-analytics-charts";
import { TrafficLogsTable } from "./traffic-logs-table";

const RANGE_LABELS: Record<TrafficRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

type AnalyticsView =
  | "vehicle-count"
  | "classification"
  | "lane-comparison"
  | "hourly-activity"
  | "traffic-logs"
  | "staff-activity"
  | "operating-hours";

const ANALYTICS_VIEW_LABELS: Record<AnalyticsView, string> = {
  "vehicle-count": "Vehicle Count Over Time",
  classification: "Vehicle Classification Distribution",
  "lane-comparison": "Lane Comparison",
  "hourly-activity": "Hourly Traffic Activity",
  "traffic-logs": "Traffic Logs",
  "staff-activity": "Staff Activity",
  "operating-hours": "Operating Hours",
};
const ANALYTICS_VIEW_STORAGE_KEY = "smartroad.analytics-view";

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading traffic analytics" role="status">
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

function isAnalyticsView(value: string): value is AnalyticsView {
  return value in ANALYTICS_VIEW_LABELS;
}

export function TrafficAnalytics() {
  const [events, setEvents] = React.useState<TrafficEvent[]>([]);
  const [dataSource, setDataSource] = React.useState<TrafficDataSource>("sample");
  const [nodeFilter, setNodeFilter] = React.useState<TrafficNodeFilter>("all");
  const [range, setRange] = React.useState<TrafficRange>("30d");
  const [analyticsView, setAnalyticsView] = React.useState<AnalyticsView>("vehicle-count");
  const [staffRoleFilter, setStaffRoleFilter] = React.useState<StaffRoleFilter>("all");
  const [staffActivities, setStaffActivities] = React.useState<StaffActivityRecord[]>([]);
  const [operatingHoursStaff, setOperatingHoursStaff] = React.useState<OperatingHoursStaff[]>([]);
  const [staffActivityLoading, setStaffActivityLoading] = React.useState(false);
  const [staffActivityError, setStaffActivityError] = React.useState<string | null>(null);
  const [specificDate, setSpecificDate] = React.useState<Date>();
  const [datePickerOpen, setDatePickerOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    const savedView = window.localStorage.getItem(ANALYTICS_VIEW_STORAGE_KEY);
    if (savedView && isAnalyticsView(savedView)) setAnalyticsView(savedView);
  }, []);

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

  React.useEffect(() => {
    if (analyticsView !== "staff-activity" && analyticsView !== "operating-hours") return;
    setStaffActivityLoading(true);
    setStaffActivityError(null);
    return subscribeToStaffActivity(
      (nextActivities, nextStaff) => {
        setStaffActivities(nextActivities);
        setOperatingHoursStaff(nextStaff);
        setStaffActivityLoading(false);
      },
      (cause) => {
        setStaffActivityError(cause.message);
        setStaffActivityLoading(false);
      },
    );
  }, [analyticsView]);

  const filteredEvents = React.useMemo(
    () => filterTrafficEvents(events, range, nodeFilter, new Date(), specificDate),
    [events, nodeFilter, range, specificDate],
  );
  const volumeData = React.useMemo(
    () => buildVolumeSeries(filteredEvents, range, specificDate),
    [filteredEvents, range, specificDate],
  );
  const classificationData = React.useMemo(() => buildClassificationSeries(filteredEvents), [filteredEvents]);
  const hourlyData = React.useMemo(() => buildHourlyActivitySeries(filteredEvents), [filteredEvents]);
  const filteredStaffActivities = React.useMemo(
    () => filterStaffActivity(staffActivities, range, new Date(), specificDate),
    [range, specificDate, staffActivities],
  );
  const operatingHoursData = React.useMemo(
    () => buildOperatingHoursSeries(staffActivities, range, staffRoleFilter, new Date(), specificDate, operatingHoursStaff),
    [operatingHoursStaff, range, specificDate, staffActivities, staffRoleFilter],
  );
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

          <Select
            value={analyticsView}
            onValueChange={(value) => {
              if (!isAnalyticsView(value)) return;
              setAnalyticsView(value);
              window.localStorage.setItem(ANALYTICS_VIEW_STORAGE_KEY, value);
            }}
          >
            <SelectTrigger aria-label="Select analytics view" className="w-56" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectGroup>
                {Object.entries(ANALYTICS_VIEW_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
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
          {analyticsView === "vehicle-count" ? (
            <TrafficVolumeChart data={volumeData} periodLabel={periodLabel} range={range} />
          ) : null}
          {analyticsView === "classification" ? <VehicleClassificationChart data={classificationData} /> : null}
          {analyticsView === "lane-comparison" ? <LaneComparisonChart data={volumeData} /> : null}
          {analyticsView === "hourly-activity" ? <HourlyActivityChart data={hourlyData} /> : null}
          {analyticsView === "operating-hours" ? (
            <>
              {staffActivityError ? (
                <Alert variant="destructive">
                  <Database />
                  <AlertTitle>Staff activity is unavailable</AlertTitle>
                  <AlertDescription>{staffActivityError}</AlertDescription>
                </Alert>
              ) : null}
              <OperatingHoursChart
                data={operatingHoursData}
                loading={staffActivityLoading}
                onRoleFilterChange={setStaffRoleFilter}
                periodLabel={periodLabel}
                roleFilter={staffRoleFilter}
              />
            </>
          ) : null}
          {analyticsView === "traffic-logs" ? (
            <TrafficLogsTable
              dataSource={dataSource}
              events={filteredEvents}
              loading={loading}
              nodeFilter={nodeFilter}
              onNodeFilterChange={setNodeFilter}
              periodLabel={periodLabel}
            />
          ) : null}
          {analyticsView === "staff-activity" ? (
            <StaffActivityTable
              activities={filteredStaffActivities}
              error={staffActivityError}
              loading={staffActivityLoading}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
