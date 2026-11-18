import type { Diagram, Port, Side } from "./model.js";

export const layoutDirection = { LR: "RIGHT", RL: "LEFT", TB: "DOWN", BT: "UP" } as const;
const inputSide: Record<Diagram["direction"], Side> = { LR: "west", RL: "east", TB: "north", BT: "south" };
const opposite: Record<Side, Side> = { north: "south", south: "north", east: "west", west: "east" };

export const defaultInterfaceSide = (flow: Diagram["direction"], direction: Port["direction"]): Side =>
  direction === "input" ? inputSide[flow] : opposite[inputSide[flow]];
export const interfaceSide = (diagram: Diagram, port: Port): Side =>
  port.side ?? defaultInterfaceSide(diagram.direction, port.direction);

export const hasPlacedPorts = (diagram: Diagram) => Object.values(diagram.ports).some(port => port.side !== null);
export const interfacePin = (direction: Port["direction"]) => direction === "input" ? "Y" : "A";
export const interfaceAlias = (name: string) => "CDL_PORT__" + name;

// The apex touches the diagram; the label stays upright when the symbol turns.
export const interfaceShape = {
  west: { width: 30, height: 20, x: 30, y: 10, labelX: 15, labelY: -4, path: "M0,0 L0,20 L15,20 L30,10 L15,0 Z" },
  east: { width: 30, height: 20, x: 0, y: 10, labelX: 15, labelY: -4, path: "M30,0 L30,20 L15,20 L0,10 L15,0 Z" },
  north: { width: 20, height: 30, x: 10, y: 30, labelX: 10, labelY: -4, path: "M0,0 L20,0 L20,15 L10,30 L0,15 Z" },
  south: { width: 20, height: 30, x: 10, y: 0, labelX: 10, labelY: 43, path: "M0,30 L20,30 L20,15 L10,0 L0,15 Z" },
} satisfies Record<Side, { width: number; height: number; x: number; y: number; labelX: number; labelY: number; path: string }>;
