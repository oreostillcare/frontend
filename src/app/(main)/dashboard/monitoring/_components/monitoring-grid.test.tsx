// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTelemetry } from "@/hooks/use-telemetry";

import { MonitoringGrid } from "./monitoring-grid";

vi.mock("@/hooks/use-telemetry", () => ({ useTelemetry: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function telemetry() {
  vi.mocked(useTelemetry).mockReturnValue({
    cameras: [
      { id: 1, configured: true, online: true, fps: 10, visibleVehicles: 3 },
      { id: 2, configured: false, online: false, testMirror: true, sourceCamera: 1, displayOnline: true },
    ],
    system: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
  });
}

describe("Live Monitoring camera views", () => {
  it("keeps two independent raw USB feeds and their node metrics separate", () => {
    vi.mocked(useTelemetry).mockReturnValue({
      cameras: [
        { id: 1, configured: true, online: true, testMirror: false, fps: 8, visibleVehicles: 3 },
        { id: 2, configured: true, online: true, testMirror: false, fps: 7, visibleVehicles: 5 },
      ],
      system: null,
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<MonitoringGrid />);
    expect(screen.getByAltText("Raw traffic feed for Camera 1").getAttribute("src")).toBe(
      "/detection/video/raw/camera/1?attempt=0",
    );
    expect(screen.getByAltText("Raw traffic feed for Camera 2").getAttribute("src")).toBe(
      "/detection/video/raw/camera/2?attempt=0",
    );
    expect(screen.queryByText("TEST MIRROR")).toBeNull();
    expect(screen.getAllByText("3")).toHaveLength(1);
    expect(screen.getAllByText("5")).toHaveLength(1);
  });

  it("shows raw views and a test-only B display without copying A metrics", () => {
    telemetry();
    render(<MonitoringGrid />);
    const first = screen.getByAltText("Raw traffic feed for Camera 1");
    const second = screen.getByAltText("Raw traffic feed for Camera 2");
    expect(first.getAttribute("src")).toBe("/detection/video/raw/camera/1?attempt=0");
    expect(second.getAttribute("src")).toBe("/detection/video/raw/camera/2?attempt=0");
    expect(screen.getByText("TEST MIRROR")).toBeTruthy();
    expect(screen.getByText(/TEST ONLY: Camera A display mirror/)).toBeTruthy();
    expect(screen.getAllByText("3")).toHaveLength(1);
  });

  it("labels the existing annotated fallback when the raw request fails", () => {
    telemetry();
    render(<MonitoringGrid />);
    fireEvent.error(screen.getByAltText("Raw traffic feed for Camera 1"));
    expect(screen.getByAltText("Annotated fallback traffic feed for Camera 1").getAttribute("src")).toBe(
      "/detection/video/camera/1?attempt=0",
    );
    expect(screen.getByText("Annotated MJPEG fallback")).toBeTruthy();
  });

  it("falls back when a raw connection never produces its first frame", async () => {
    vi.useFakeTimers();
    telemetry();
    render(<MonitoringGrid />);
    await act(() => vi.advanceTimersByTimeAsync(10001));
    expect(screen.getByAltText("Annotated fallback traffic feed for Camera 1")).toBeTruthy();
  });
});
