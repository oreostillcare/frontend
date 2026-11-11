"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { useNodeAlarms } from "@/app/(main)/dashboard/_components/node-alarm-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { auth } from "@/lib/firebase/client";

type Coordinate = { lat: number; lng: number };

type MockNode = {
  id: string;
  label: string;
  location: string;
  position: Coordinate;
};

type NodeState = "gray" | "green" | "red";

type NodeEvent = {
  date: string;
  location: string;
  time: string;
};

const mockNodes: MockNode[] = [
  {
    id: "node-a",
    label: "Node A",
    location: "C.M. Recto Avenue, Lipa City",
    position: { lat: 13.94098, lng: 121.16204 },
  },
  {
    id: "node-b",
    label: "Node B",
    location: "C.M. Recto Avenue, Lipa City",
    position: { lat: 13.94188, lng: 121.16442 },
  },
];

const mapCenter = { lat: 13.94143, lng: 121.16323 };

function createNodeEvent(node: MockNode): NodeEvent {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat("en-PH", { dateStyle: "long" }).format(now),
    location: node.location,
    time: new Intl.DateTimeFormat("en-PH", { timeStyle: "medium" }).format(now),
  };
}

function createNodeMarker(label: string, location: string, state: NodeState) {
  const marker = document.createElement("div");
  marker.setAttribute("aria-label", label);
  marker.style.alignItems = "center";
  marker.style.display = "flex";
  marker.style.flexDirection = "column";
  marker.style.gap = "4px";

  const pin = document.createElement("div");
  pin.dataset.nodePin = "true";
  pin.textContent = label.replace("Node ", "");
  pin.style.alignItems = "center";
  pin.style.background = state === "green" ? "#16a34a" : state === "red" ? "#dc2626" : "#6b7280";
  pin.style.border = "2px solid white";
  pin.style.borderRadius = "999px 999px 999px 0";
  pin.style.boxShadow = "0 2px 6px rgb(0 0 0 / 40%)";
  pin.style.color = "white";
  pin.style.display = "flex";
  pin.style.fontSize = "12px";
  pin.style.fontWeight = "700";
  pin.style.height = "32px";
  pin.style.justifyContent = "center";
  pin.style.transform = "rotate(-45deg)";
  pin.style.width = "32px";
  pin.style.animation = state === "red" ? "smartroad-node-pulse 1.1s ease-in-out infinite" : "none";

  const pinText = document.createElement("span");
  pinText.style.transform = "rotate(45deg)";
  pinText.textContent = pin.textContent;
  pin.replaceChildren(pinText);

  const caption = document.createElement("span");
  caption.style.background = "rgb(0 0 0 / 80%)";
  caption.style.borderRadius = "4px";
  caption.style.color = "white";
  caption.style.fontSize = "12px";
  caption.style.padding = "2px 6px";
  caption.textContent = label;

  const locationCaption = document.createElement("span");
  locationCaption.style.background = "rgb(0 0 0 / 80%)";
  locationCaption.style.borderRadius = "4px";
  locationCaption.style.color = "white";
  locationCaption.style.fontSize = "10px";
  locationCaption.style.padding = "2px 5px";
  locationCaption.textContent = location;

  marker.append(pin, caption, locationCaption);
  return marker;
}

function MockMapPreview({ nodeStates }: { nodeStates: Record<string, NodeState> }) {
  return (
    <div className="relative h-96 overflow-hidden rounded-lg border bg-muted">
      <div className="absolute inset-x-0 top-1/3 border-t border-dashed border-muted-foreground/30" />
      <div className="absolute inset-x-0 top-2/3 border-t border-dashed border-muted-foreground/30" />
      <div className="absolute inset-y-0 left-1/3 border-l border-dashed border-muted-foreground/30" />
      <div className="absolute inset-y-0 left-2/3 border-l border-dashed border-muted-foreground/30" />
      {mockNodes.map((node, index) => (
        <div
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          key={node.id}
          style={{ left: index === 0 ? "35%" : "65%", top: index === 0 ? "42%" : "60%" }}
        >
          <div
            className={`flex size-9 items-center justify-center rounded-full border-2 border-background font-semibold text-primary-foreground shadow-lg ${
              nodeStates[node.id] === "green"
                ? "bg-green-600"
                : nodeStates[node.id] === "red"
                  ? "animate-pulse bg-red-600"
                  : "bg-muted-foreground"
            }`}
          >
            {node.label.replace("Node ", "")}
          </div>
          <span className="rounded bg-background/90 px-2 py-1 text-xs shadow">{node.label}</span>
        </div>
      ))}
      <div className="absolute right-3 bottom-3 rounded-md bg-background/90 px-3 py-2 text-muted-foreground text-xs shadow">
        Static mock preview · add a MapTiler key for satellite imagery
      </div>
    </div>
  );
}

export function LiveMap() {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<MapLibreMap | null>(null);
  const markerElementsRef = useRef<Record<string, HTMLDivElement>>({});
  const [mapError, setMapError] = useState<string | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({
    "node-a": "gray",
    "node-b": "gray",
  });
  const [nodeEvents, setNodeEvents] = useState<Record<string, NodeEvent>>({});
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  const [pendingTargetState, setPendingTargetState] = useState<NodeState | null>(null);
  const [pendingEvent, setPendingEvent] = useState<NodeEvent | null>(null);
  const [showMockPreview, setShowMockPreview] = useState(false);
  const mapsKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY?.trim();
  const { setAlarm } = useNodeAlarms();

  const pendingNode = mockNodes.find((node) => node.id === pendingNodeId);

  const requestNodeTransition = (nodeId: string, targetState: NodeState) => {
    const node = mockNodes.find((item) => item.id === nodeId);
    if (!node) {
      return;
    }

    setPendingNodeId(nodeId);
    setPendingTargetState(targetState);
    setPendingEvent(createNodeEvent(node));
  };

  const confirmNodeTransition = () => {
    if (!pendingNodeId || !pendingTargetState || !pendingEvent || !pendingNode) {
      return;
    }

    void (async () => {
      const token = await auth?.currentUser?.getIdToken();
      if (token) {
        const response = await fetch("/api/node-states", {
          body: JSON.stringify({ event: pendingEvent, nodeId: pendingNodeId, state: pendingTargetState }),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) return;
      }

      setNodeStates((current) => ({ ...current, [pendingNodeId]: pendingTargetState }));
      setNodeEvents((current) => ({ ...current, [pendingNodeId]: pendingEvent }));
      setAlarm(
        pendingNodeId,
        pendingTargetState === "red"
          ? { ...pendingEvent, nodeId: pendingNodeId, nodeLabel: pendingNode.label }
          : null,
      );
      setPendingNodeId(null);
      setPendingTargetState(null);
      setPendingEvent(null);
    })();
  };

  useEffect(() => {
    if (!auth) return;

    let refreshTimer: number | undefined;
    let cancelled = false;
    const loadSharedStates = async (token: string) => {
      const response = await fetch("/api/node-states", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        states?: Array<{ event: NodeEvent | null; nodeId: string; state: NodeState }>;
      };
      if (cancelled || !payload.states) return;
      setNodeStates(Object.fromEntries(payload.states.map((state) => [state.nodeId, state.state])));
      setNodeEvents(
        Object.fromEntries(
          payload.states.filter((state) => state.event).map((state) => [state.nodeId, state.event as NodeEvent]),
        ),
      );
    };

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (refreshTimer) window.clearInterval(refreshTimer);
      if (!user) return;
      const refresh = () => void user.getIdToken().then(loadSharedStates).catch(() => undefined);
      refresh();
      refreshTimer = window.setInterval(refresh, 5000);
    });

    return () => {
      cancelled = true;
      if (refreshTimer) window.clearInterval(refreshTimer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    for (const node of mockNodes) {
      const pin = markerElementsRef.current[node.id]?.querySelector<HTMLElement>("[data-node-pin]");
      if (pin) {
        const state = nodeStates[node.id] ?? "gray";
        pin.style.background = state === "green" ? "#16a34a" : state === "red" ? "#dc2626" : "#6b7280";
        pin.style.animation = state === "red" ? "smartroad-node-pulse 1.1s ease-in-out infinite" : "none";
      }
    }
  }, [nodeStates]);

  useEffect(() => {
    if (!mapsKey || !mapElementRef.current) {
      return;
    }

    let disposed = false;
    let map: MapLibreMap | null = null;

    void import("maplibre-gl")
      .then(({ Map, Marker, NavigationControl, Popup, setWorkerUrl }) => {
        if (disposed || !mapElementRef.current) {
          return;
        }

        setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());

        const mapInstance = new Map({
          attributionControl: true,
          center: [mapCenter.lng, mapCenter.lat],
          container: mapElementRef.current,
          style: `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${encodeURIComponent(mapsKey)}`,
          zoom: 15,
        });
        map = mapInstance;
        mapInstanceRef.current = mapInstance;

        let loaded = false;
        mapInstance.once("load", () => {
          loaded = true;
        });
        mapInstance.on("error", (event) => {
          if (loaded || disposed) {
            return;
          }

          const detail = event.error instanceof Error ? event.error.message : "The key or allowed origin was rejected.";
          setMapError(`MapTiler could not load the satellite map: ${detail}`);
          map?.remove();
          map = null;
          mapInstanceRef.current = null;
          setShowMockPreview(true);
        });
        mapInstance.addControl(new NavigationControl(), "top-right");

        for (const node of mockNodes) {
          const markerElement = createNodeMarker(node.label, node.location, "gray");
          markerElementsRef.current[node.id] = markerElement;
          const popup = new Popup({ className: "smartroad-map-popup", offset: 25 }).setHTML(
            `<strong>${node.label}</strong><br />${node.location}<br />Mock GPS position`,
          );
          new Marker({ anchor: "bottom", element: markerElement })
            .setLngLat([node.position.lng, node.position.lat])
            .setPopup(popup)
            .addTo(mapInstance);
        }
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "The map library failed to load.";
        setMapError(`MapTiler could not be loaded: ${detail}`);
        setShowMockPreview(true);
      });

    return () => {
      disposed = true;
      map?.remove();
      map = null;
      mapInstanceRef.current = null;
      markerElementsRef.current = {};
    };
  }, [mapsKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Maps</CardTitle>
        <CardDescription>Mock Node A and Node B positions; backend locations will be connected later.</CardDescription>
        <CardAction>
          <Badge variant="outline">SATELLITE · MOCK DATA</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!mapsKey || showMockPreview ? (
          <>
            <MockMapPreview nodeStates={nodeStates} />
            <p className={mapError ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
              {mapError ?? "Add NEXT_PUBLIC_MAPTILER_API_KEY to switch this mock preview to satellite imagery."}
            </p>
          </>
        ) : (
          <>
            <div ref={mapElementRef} className="h-96 w-full overflow-hidden rounded-lg bg-muted" />
            {mapError && <p className="text-destructive text-sm">{mapError}</p>}
          </>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          {mockNodes.map((node) => {
            const state = nodeStates[node.id] ?? "gray";
            const event = nodeEvents[node.id];

            return (
              <div className="rounded-lg border bg-muted/30 px-3 py-3 text-sm" key={node.id}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{node.label}</span>
                      <Badge variant={state === "red" ? "destructive" : state === "green" ? "default" : "outline"}>
                        {state === "red" ? "COMPROMISED" : state.toUpperCase()}
                      </Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground text-xs">{node.location}</p>
                    {event && (
                      <p className="mt-1 text-muted-foreground text-xs">
                        {event.date} · {event.time}
                      </p>
                    )}
                    <p className="mt-1 text-muted-foreground text-xs">
                      {node.position.lat.toFixed(4)}, {node.position.lng.toFixed(4)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Switch
                      aria-label={`${node.label} state switch`}
                      checked={state !== "gray"}
                      onCheckedChange={(checked) => requestNodeTransition(node.id, checked ? "green" : "gray")}
                    />
                    <Button onClick={() => requestNodeTransition(node.id, "red")} size="sm" variant="destructive">
                      Mock warning
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <AlertDialog
          open={pendingNodeId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingNodeId(null);
              setPendingTargetState(null);
              setPendingEvent(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingTargetState === "green"
                  ? `Confirm origin for ${pendingNode?.label ?? "node"}`
                  : pendingTargetState === "red"
                    ? `Trigger mock warning for ${pendingNode?.label ?? "node"}`
                    : `Confirm retrieval of ${pendingNode?.label ?? "node"}`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                <span className="flex flex-col gap-1">
                  <span>
                    Location: {pendingEvent?.location ?? pendingNode?.location ?? "Unknown"}
                  </span>
                  <span>Time: {pendingEvent?.time ?? "--"}</span>
                  <span>Date: {pendingEvent?.date ?? "--"}</span>
                  <span className="mt-1">
                    {pendingTargetState === "green"
                      ? "Confirm to finalize this origin position."
                      : pendingTargetState === "red"
                        ? "Confirm to trigger the mock displacement warning."
                        : "Confirm retrieval to return this node to gray."}
                  </span>
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmNodeTransition}>Confirm</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
