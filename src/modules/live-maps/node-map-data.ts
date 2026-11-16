export type Coordinate = { lat: number; lng: number };

// Shared node coordinate, label, and display-state types used by the map UI.

export type MockNode = {
  id: string;
  label: string;
  location: string;
  position: Coordinate;
};

export type NodeState = "gray" | "green" | "red";

export type NodeEvent = {
  date: string;
  location: string;
  time: string;
};

export const mockNodes: MockNode[] = [
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

export const mapCenter = { lat: 13.94143, lng: 121.16323 };

export function createNodeEvent(node: MockNode): NodeEvent {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat("en-PH", { dateStyle: "long" }).format(now),
    location: node.location,
    time: new Intl.DateTimeFormat("en-PH", { timeStyle: "medium" }).format(now),
  };
}
