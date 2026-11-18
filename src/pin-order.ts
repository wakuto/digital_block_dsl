import type { Diagram, Port, Side } from "./model.js";
import type { NetlistGraph } from "./port-layout.js";
import type { ElkPoint } from "elkjs";

export type PinOrders = ReadonlyMap<string, ReadonlyMap<string, number>>;
type MutableOrders = Map<string, Map<string, number>>;

const reorderable = new Set(["CMP", "AND", "OR", "XOR", "MUX", "ADD"]);

export function orderedSlots(ports: Port[], order?: ReadonlyMap<string, number>): Port[] {
  if (!order) return ports;
  const sorted = ports.filter(p => order.has(p.name)).sort((a,b) => order.get(a.name)! - order.get(b.name)!);
  let i = 0;
  return ports.map(p => order.has(p.name) ? sorted[i++] : p);
}

export function swappableInputs(diagram: Diagram) {
  const connected = new Set(diagram.wirings.flatMap(wire => wire.sinks.map(sink => sink.endpoint)));
  return Object.values(diagram.blocks).flatMap(block => {
    if (!block.builtin || !reorderable.has(block.type)) return [];
    const groups = new Map<Side, string[]>();
    for (const p of Object.values(block.ports)) {
      if (p.direction !== "input" || (block.type === "MUX" && p.name === "S")) continue;
      const side = p.side ?? "west";
      const pins = groups.get(side) ?? [];
      pins.push(p.name);
      groups.set(side,pins);
    }
    const quarterTurn = block.explicitRotation||block.rotation ? block.rotation===90||block.rotation===270
      : (diagram.direction === "TB" || diagram.direction === "BT")&&!Object.values(block.ports).some(p => p.explicitSide);
    return [...groups].filter(([,pins]) => pins.filter(pin => connected.has(block.id + "." + pin)).length > 1).map(([side,pins]) => ({
      block: block.id, pins,
      axis: ((side === "north" || side === "south") !== quarterTurn ? "x" : "y") as "x" | "y",
    }));
  });
}
type Group = ReturnType<typeof swappableInputs>[number];

function signalPositions(layout: NetlistGraph): Map<string, ElkPoint> {
  const result = new Map<string, ElkPoint>();
  const counts = new Map<string, number>();
  for (const edge of layout.edges) {
    const source = edge.sections?.[0]?.startPoint;
    if (!edge.targetPort || !source) continue;
    const last = result.get(edge.targetPort) ?? { x: 0, y: 0 };
    const count = (counts.get(edge.targetPort) ?? 0) + 1;
    result.set(edge.targetPort, { x: last.x + (source.x-last.x)/count, y: last.y + (source.y-last.y)/count });
    counts.set(edge.targetPort, count);
  }
  return result;
}

function readOrder(group: Group, orders: PinOrders) {
  const ranks = orders.get(group.block);
  return ranks ? [...group.pins].sort((a,b) => (ranks.get(a) ?? group.pins.indexOf(a)) - (ranks.get(b) ?? group.pins.indexOf(b))) : group.pins;
}
function updateOrder(orders: MutableOrders, group: Group, pins: string[]) {
  const copy = new Map(orders);
  const ranks = new Map(copy.get(group.block));
  pins.forEach((pin,i) => ranks.set(pin,i));
  copy.set(group.block,ranks);
  return copy;
}

function align(group: Group, pins: string[], root: string, sources: Map<string, ElkPoint>) {
  const at = (name: string) => sources.get(root + "." + group.block + "." + name)?.[group.axis];
  // Keep any unwired pins in their original slots.
  const connected = pins.filter(p => at(p) !== undefined).sort((a,b) => at(a)! - at(b)!);
  let i = 0;
  return pins.map(p => at(p) === undefined ? p : connected[i++]);
}

type Segment = { constant: number; start: number; end: number; driver: string };
function routingScore(layout: NetlistGraph) {
  const h: Segment[] = [], v: Segment[] = [];
  let length = 0;
  for (const edge of layout.edges) for (const section of edge.sections ?? []) {
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const driver = edge.sourcePort ?? edge.source ?? edge.id;
    for (let i = 1; i < points.length; i++) {
      const [a,b] = [points[i-1],points[i]];
      if (a.x === b.x && a.y !== b.y) v.push({ constant:a.x,start:Math.min(a.y,b.y),end:Math.max(a.y,b.y),driver });
      if (a.y === b.y && a.x !== b.x) h.push({ constant:a.y,start:Math.min(a.x,b.x),end:Math.max(a.x,b.x),driver });
      length += Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
    }
  }
  // Count proper intersections between different signals. Bends and
  // junctions on a fanout wire do not count as crossings.
  const crossings = new Set<string>();
  for (const a of h) for (const b of v) {
    if (a.driver !== b.driver && a.start < b.constant && b.constant < a.end && b.start < a.constant && a.constant < b.end) {
      const [first,second] = a.driver < b.driver ? [a.driver,b.driver] : [b.driver,a.driver];
      crossings.add(JSON.stringify([first,second,b.constant,a.constant]));
    }
  }
  return { crossings:crossings.size,length };
}

/** Search a bounded number of routed alternatives; keep the best actual crossing count. */
export async function improvePinOrder<T extends { layout: NetlistGraph }>(
  diagram: Diagram, initial: T, route: (orders: PinOrders) => Promise<T>,
): Promise<T> {
  const candidates = swappableInputs(diagram);
  let best = initial;
  let bestOrders: MutableOrders = new Map();
  let score = routingScore(best.layout);
  let remaining = 8;
  const signatureFor = (orders: PinOrders) => JSON.stringify(candidates.map(group => readOrder(group,orders)));
  const tried = new Set<string>([signatureFor(bestOrders)]);
  const evaluate = async (orders: MutableOrders) => {
    if (!remaining) return;
    const signature = signatureFor(orders);
    if (tried.has(signature)) return;
    tried.add(signature);
    remaining--;
    const next = await route(orders);
    const nextScore = routingScore(next.layout);
    if (nextScore.crossings < score.crossings
      || (nextScore.crossings === score.crossings && nextScore.length < score.length-0.01)) {
      best = next;
      bestOrders = orders;
      score = nextScore;
    }
  };
  const root = initial.layout.id;
  const sources = signalPositions(initial.layout);
  const groups = candidates.filter(group => group.pins.filter(pin =>
    sources.has(root + "." + group.block + "." + pin)).length >= 2);
  let combined = bestOrders;
  for (const group of groups) {
    const pins = align(group,group.pins,root,sources);
    if (pins.some((pin,i) => pin !== group.pins[i])) combined = updateOrder(combined,group,pins);
  }
  await evaluate(combined);
  // A local swap can win even where the relative source positions alone
  // are misleading (e.g. an intervening fanout or another block).
  for (const group of groups) {
    if (!remaining) break;
    const pins = readOrder(group,bestOrders);
    const sorted = align(group,pins,root,signalPositions(best.layout));
    if (pins.some((pin,i) => pin !== sorted[i])) await evaluate(updateOrder(bestOrders,group,sorted));
    if (score.crossings) {
      const current = readOrder(group,bestOrders);
      const wired = current.flatMap((pin,i) => sources.has(root + "." + group.block + "." + pin) ? [i] : []);
      // Use a few nearby swaps on wide symbols as well as sorting their inputs.
      const start = bestOrders;
      for (let i=1;i<Math.min(wired.length,4)&&remaining;i++) {
        const swap = [...current], a=wired[i-1],b=wired[i];
        [swap[a],swap[b]] = [swap[b],swap[a]];
        await evaluate(updateOrder(start,group,swap));
      }
    }
  }
  return best;
}
