/** Implementation-independent IR for Circuit Diagram DSL. */
export type Direction = "input" | "output";
export type Side = "west" | "east" | "north" | "south";
export type ParamValue = number | string;

export interface Port { name: string; direction: Direction; width: number | null; side: Side | null; line: number }
export interface Block { id: string; type: string; label: string; ports: Record<string, Port>; params: Record<string, ParamValue>; line: number; builtin: boolean; style: string | null; rotation: 0 | 90 | 180 | 270; flipX: boolean; flipY: boolean; rank: number | null }
export interface Net { driver: string; sinks: string[]; width: number | null; name: string | null; line: number }
export interface SignalRef { endpoint: string; msb: number | null; lsb: number | null }
export interface Wiring { sources: SignalRef[]; sinks: SignalRef[]; name: string | null; width: number | null; line: number }
export interface Group { label: string; members: string[]; line: number }
export interface Diagram { title: string; direction: "LR" | "RL" | "TB" | "BT"; theme: "light" | "dark" | "mono"; layout: "balanced" | "compact" | "feedback"; netlabels: boolean; ports: Record<string, Port>; blocks: Record<string, Block>; nets: Net[]; wirings: Wiring[]; groups: Group[] }

export class DiagramError extends Error {
  constructor(public code: string, public detail: string, public line = 0, public column = 0) {
    super(line ? `${code} at ${line}:${column}: ${detail}` : `${code}: ${detail}`);
    this.name = "DiagramError";
  }
}

export function signalToString(ref: SignalRef): string {
  if (ref.msb === null) return ref.endpoint;
  return ref.msb === ref.lsb ? `${ref.endpoint}[${ref.msb}]` : `${ref.endpoint}[${ref.msb}:${ref.lsb}]`;
}
