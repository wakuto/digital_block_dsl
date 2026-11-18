import type { ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from "elkjs";
import { interfacePin, interfaceShape, interfaceSide } from "./interface-ports.js";
import type { Diagram } from "./model.js";
import { layoutOptions } from "./skin.js";
import { textWidth } from "./table.js";

type NetlistEdge = Omit<ElkExtendedEdge, "sources" | "targets"> & {
  source?: string; sourcePort?: string; target?: string; targetPort?: string;
};
export type NetlistGraph = Omit<ElkNode, "edges"> & { edges: NetlistEdge[] };
export interface PortLayouter { layout(graph: ElkNode): Promise<ElkNode> }

/** Route to real ELK boundary ports, then restore the exterior symbols for Netlist2SVG to draw. */
export async function placeInterfacePorts(diagram: Diagram, graph: NetlistGraph, elk: PortLayouter): Promise<NetlistGraph> {
  const symbols = new Map(Object.values(diagram.ports).map(port => [
    graph.id + "." + port.name, { port, side: interfaceSide(diagram, port) },
  ]));
  const originalNodes = new Map((graph.children ?? []).map(node => [node.id,node]));
  const children = (graph.children ?? []).filter(node => !symbols.has(node.id));
  const ports: ElkPort[] = [...symbols].map(([id, { port, side }]) => {
    const vertical = side === "north" || side === "south";
    return {
      id: id + "." + interfacePin(port.direction),
      width: vertical ? Math.ceil(Math.max(20, textWidth(port.name))) : 0,
      height: vertical ? 0 : 26,
      layoutOptions: { "org.eclipse.elk.port.side": side.toUpperCase() },
    };
  });
  const portIds = new Set(ports.map(port => port.id));
  const edges: ElkExtendedEdge[] = [];
  const passthroughs = new Map<string, string>();
  for (const edge of graph.edges) {
    const source = edge.sourcePort ?? edge.source;
    const target = edge.targetPort ?? edge.target;
    if (!source || !target) throw new Error("Netlist2SVG returned an edge without endpoints");
    const { id, labels, layoutOptions } = edge;
    if (portIds.has(source) && portIds.has(target)) {
      // Route direct port-to-port links through an internal point so they stay inside the diagram.
      const relay = id + ".$relay";
      children.push({ id: relay, width: 0, height: 0 });
      edges.push({ id, sources: [source], targets: [relay], labels, layoutOptions });
      const tail = id + ".$tail";
      edges.push({ id: tail, sources: [relay], targets: [target], layoutOptions });
      passthroughs.set(id, tail);
    } else {
      edges.push({ id, sources: [source], targets: [target], labels, layoutOptions });
    }
  }
  // ELK needs interior content in order to distribute ports on an otherwise empty diagram.
  if (!children.length) children.push({ id: graph.id + ".$empty", width: 1, height: 1 });
  const options = layoutOptions(diagram);
  const result = await elk.layout({
    id: "cdiag_boundary",
    layoutOptions: { ...options, "org.eclipse.elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [{
      id: graph.id,
      children, edges, ports,
      layoutOptions: {
        ...options,
        "org.eclipse.elk.portConstraints": "FIXED_SIDE",
        "org.eclipse.elk.spacing.portPort": "12",
        "org.eclipse.elk.padding": "[top=24,left=24,bottom=24,right=24]",
      },
    }],
  });
  const body = result.children![0];
  const dx = Math.ceil(Math.max(52, ...Object.values(diagram.ports).map(p => textWidth(p.name) / 2 + 24)));
  const dy = 50;
  const positionedPorts = new Map(body.ports!.map(port => [port.id, port]));
  const moved = (point: ElkPoint) => ({ x: point.x + dx, y: point.y + dy });
  const positionedEdges = new Map(body.edges!.map(edge => [edge.id, edge]));
  const outEdges = graph.edges.map(edge => {
    const laidOut = positionedEdges.get(edge.id)!;
    const tail = positionedEdges.get(passthroughs.get(edge.id) ?? "");
    return {
      ...edge,
      sections: [...(laidOut.sections ?? []), ...(tail?.sections ?? [])].map(section => ({
        ...section,
        startPoint: moved(section.startPoint), endPoint: moved(section.endPoint),
        bendPoints: section.bendPoints?.map(moved),
      })),
      junctionPoints: laidOut.junctionPoints?.map(moved),
      labels: laidOut.labels?.map(label => ({ ...label, x: label.x! + dx, y: label.y! + dy })),
    };
  });
  const outChildren = body.children!.map(node => ({ ...node, ...moved({ x: node.x!, y: node.y! }) }));
  for (const [id, { port, side }] of symbols) {
    const pos = positionedPorts.get(id + "." + interfacePin(port.direction))!;
    const shape = interfaceShape[side];
    outChildren.push({
      id, width: shape.width, height: shape.height,
      x: dx + pos.x! + pos.width! / 2 - shape.x,
      y: dy + pos.y! + pos.height! / 2 - shape.y,
      labels: originalNodes.get(id)?.labels,
      ports: originalNodes.get(id)?.ports,
    });
  }
  return { id: graph.id, width: body.width! + dx * 2, height: body.height! + dy * 2, children: outChildren, edges: outEdges };
}
