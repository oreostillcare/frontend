"use client";

// Visualizes traffic counts, classes, and decision metrics from analytics data.

import type { ReactNode } from "react";
import * as React from "react";

import { BarChart3, ChevronLeft, ChevronRight } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, LineChart, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { HourlyActivityPoint, TrafficRange, TrafficVolumePoint, VehicleClassPoint } from "./analytics-sample-data";
import type { OperatingHoursPoint, StaffRoleFilter } from "./staff-activity-data";

const rangeLabels = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
} satisfies Record<TrafficRange, string>;

const trafficVolumeConfig = {
  total: {
    label: "Total traffic",
    color: "var(--foreground)",
  },
  nodeA: {
    label: "Node A",
    color: "var(--chart-2)",
  },
  nodeB: {
    label: "Node B",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const laneComparisonConfig = {
  nodeA: {
    label: "Node A",
    color: "var(--chart-2)",
  },
  nodeB: {
    label: "Node B",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const vehicleClassificationConfig = {
  nodeA: {
    label: "Node A",
    color: "var(--chart-2)",
  },
  nodeB: {
    label: "Node B",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const hourlyActivityConfig = {
  total: {
    label: "Vehicles",
    color: "var(--foreground)",
  },
} satisfies ChartConfig;

const operatingHoursConfig = {
  hours: {
    label: "Hours online",
    color: "var(--foreground)",
  },
} satisfies ChartConfig;

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

function formatCount(value: number | string) {
  const count = typeof value === "number" ? value : Number(value);

  return Number.isFinite(count) ? compactNumberFormatter.format(count) : "0";
}

function ChartEmptyState({ description }: { description: string }) {
  return (
    <Empty className="h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BarChart3 />
        </EmptyMedia>
        <EmptyTitle>No traffic data</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function TrafficVolumeChart({
  data,
  periodLabel,
  range,
}: {
  data: TrafficVolumePoint[];
  periodLabel?: string;
  range: TrafficRange;
}) {
  const hasData = data.some((point) => point.total > 0);

  return (
    <Card className="@container/card h-full">
      <CardHeader>
        <CardTitle>Vehicle Count Over Time</CardTitle>
        <CardDescription>Total detections with a per-node breakdown for the selected period.</CardDescription>
        <CardAction>
          <Badge variant="outline">{periodLabel ?? rangeLabels[range]}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={trafficVolumeConfig} className="aspect-auto h-72 w-full">
            <ComposedChart accessibilityLayer data={data} margin={{ bottom: 0, left: 0, right: 4, top: 0 }}>
              <defs>
                <linearGradient id="traffic-volume-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeOpacity={0.55} />
              <XAxis axisLine={false} dataKey="label" minTickGap={28} tickLine={false} tickMargin={10} />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickFormatter={formatCount}
                tickLine={false}
                tickMargin={8}
                width={36}
              />
              <ChartTooltip
                cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
                content={<ChartTooltipContent indicator="line" />}
              />
              <ChartLegend verticalAlign="top" content={<ChartLegendContent className="mb-4 justify-end" />} />
              <Area
                activeDot={{ r: 4 }}
                dataKey="total"
                dot={false}
                fill="url(#traffic-volume-fill)"
                fillOpacity={1}
                stroke="var(--color-total)"
                strokeWidth={2.25}
                type="monotone"
              />
              <Line
                dataKey="nodeA"
                dot={false}
                stroke="var(--color-nodeA)"
                strokeOpacity={0.85}
                strokeWidth={1.5}
                type="monotone"
              />
              <Line
                dataKey="nodeB"
                dot={false}
                stroke="var(--color-nodeB)"
                strokeDasharray="5 5"
                strokeOpacity={0.8}
                strokeWidth={1.5}
                type="monotone"
              />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <ChartEmptyState description="Vehicle totals will appear here when detections are available." />
        )}
      </CardContent>
    </Card>
  );
}

export function LaneComparisonChart({ data }: { data: TrafficVolumePoint[] }) {
  const hasData = data.some((point) => point.nodeA > 0 || point.nodeB > 0);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Lane Comparison</CardTitle>
        <CardDescription>Compare vehicle flow recorded by Node A and Node B.</CardDescription>
        <CardAction>
          <Badge variant="outline">Node A vs Node B</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={laneComparisonConfig} className="aspect-auto h-64 w-full">
            <LineChart accessibilityLayer data={data} margin={{ bottom: 0, left: 0, right: 4, top: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis axisLine={false} dataKey="label" minTickGap={24} tickLine={false} tickMargin={10} />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickFormatter={formatCount}
                tickLine={false}
                tickMargin={8}
                width={36}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <ChartLegend verticalAlign="top" content={<ChartLegendContent className="mb-4 justify-end" />} />
              <Line
                activeDot={{ r: 4 }}
                dataKey="nodeA"
                dot={false}
                stroke="var(--color-nodeA)"
                strokeLinecap="round"
                strokeWidth={2.5}
                type="monotone"
              />
              <Line
                activeDot={{ r: 4 }}
                dataKey="nodeB"
                dot={false}
                stroke="var(--color-nodeB)"
                strokeDasharray="5 5"
                strokeLinecap="round"
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ChartContainer>
        ) : (
          <ChartEmptyState description="Lane comparison will appear after both nodes report detections." />
        )}
      </CardContent>
    </Card>
  );
}

export function VehicleClassificationChart({ data }: { data: VehicleClassPoint[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Vehicle Classification Distribution</CardTitle>
        <CardDescription>Detected vehicle classes grouped by traffic node.</CardDescription>
        <CardAction>
          <Badge variant="outline">{data.length} classes</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ChartContainer config={vehicleClassificationConfig} className="aspect-auto h-64 w-full">
            <BarChart
              accessibilityLayer
              barCategoryGap="24%"
              barGap={3}
              data={data}
              margin={{ bottom: 0, left: 0, right: 4, top: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                minTickGap={8}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={10}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickFormatter={formatCount}
                tickLine={false}
                tickMargin={8}
                width={36}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <ChartLegend verticalAlign="top" content={<ChartLegendContent className="mb-4 justify-end" />} />
              <Bar dataKey="nodeA" fill="var(--color-nodeA)" maxBarSize={34} radius={[6, 6, 0, 0]} />
              <Bar dataKey="nodeB" fill="var(--color-nodeB)" fillOpacity={0.72} maxBarSize={34} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <ChartEmptyState description="Classification totals will appear after vehicles are detected." />
        )}
      </CardContent>
    </Card>
  );
}

export function HourlyActivityChart({ data }: { data: HourlyActivityPoint[] }) {
  const hasData = data.some((point) => point.total > 0);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Hourly Traffic Activity</CardTitle>
        <CardDescription>Combined detections across both nodes by hour of day.</CardDescription>
        <CardAction>
          <Badge variant="outline">24-hour view</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={hourlyActivityConfig} className="aspect-auto h-64 w-full">
            <BarChart accessibilityLayer data={data} margin={{ bottom: 0, left: 0, right: 4, top: 0 }}>
              <defs>
                <linearGradient id="hourly-activity-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.9} />
                  <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.3} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                minTickGap={18}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={10}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickFormatter={formatCount}
                tickLine={false}
                tickMargin={8}
                width={36}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <Bar dataKey="total" fill="url(#hourly-activity-fill)" maxBarSize={30} radius={[5, 5, 0, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <ChartEmptyState description="Hourly traffic patterns will appear when detections are available." />
        )}
      </CardContent>
    </Card>
  );
}

export function OperatingHoursChart({
  data,
  loading,
  onRoleFilterChange,
  periodLabel,
  roleFilter,
}: {
  data: OperatingHoursPoint[];
  loading: boolean;
  onRoleFilterChange: (value: StaffRoleFilter) => void;
  periodLabel: string;
  roleFilter: StaffRoleFilter;
}) {
  const [page, setPage] = React.useState(0);
  const pageCount = Math.max(1, Math.ceil(data.length / 7));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleData = data.slice(currentPage * 7, currentPage * 7 + 7);
  const hasData = data.length > 0;
  let chartContent: ReactNode;

  if (loading) {
    chartContent = <ChartEmptyState description="Loading staff activity..." />;
  } else if (hasData) {
    chartContent = (
      <ChartContainer config={operatingHoursConfig} className="aspect-auto h-72 w-full">
        <BarChart
          accessibilityLayer
          data={visibleData}
          layout="vertical"
          margin={{ bottom: 0, left: 0, right: 12, top: 0 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis
            allowDecimals
            axisLine={false}
            tickFormatter={(value) => `${value}h`}
            tickLine={false}
            type="number"
          />
          <YAxis axisLine={false} dataKey="name" tickLine={false} type="category" width={160} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Bar dataKey="hours" fill="var(--color-hours)" minPointSize={3} maxBarSize={32} radius={5}>
            {visibleData.map((point) => (
              <Cell
                fill={point.role === "Operator" ? "var(--muted-foreground)" : "var(--foreground)"}
                key={point.username}
              />
            ))}
            <LabelList dataKey="hours" formatter={(value) => `${value}h`} position="right" />
          </Bar>
        </BarChart>
      </ChartContainer>
    );
  } else {
    chartContent = <ChartEmptyState description={`No online staff time recorded for ${periodLabel}.`} />;
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Operating Hours</CardTitle>
        <CardDescription>Staff online time grouped by username for the selected period.</CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Select
              value={roleFilter}
              onValueChange={(value) => {
                if (value === "all" || value === "Administrator" || value === "Operator") {
                  setPage(0);
                  onRoleFilterChange(value);
                }
              }}
            >
              <SelectTrigger aria-label="Select staff role" className="w-32" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" position="popper">
                <SelectGroup>
                  <SelectItem value="all">All staff</SelectItem>
                  <SelectItem value="Administrator">Administrators</SelectItem>
                  <SelectItem value="Operator">Operators</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              aria-label="Previous operating hours page"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              size="icon-sm"
              variant="outline"
            >
              <ChevronLeft />
            </Button>
            <Button
              aria-label="Next operating hours page"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
              size="icon-sm"
              variant="outline"
            >
              <ChevronRight />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>{chartContent}</CardContent>
    </Card>
  );
}
