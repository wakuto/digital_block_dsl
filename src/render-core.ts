import { parse } from "./parser.js";
import type { Diagram } from "./model.js";
import { compileNetlist } from "./netlist.js";
import { generateSkin, layoutOptions } from "./skin.js";
import { hasPlacedPorts } from "./interface-ports.js";
import { placeInterfacePorts, type NetlistGraph, type PortLayouter } from "./port-layout.js";
import { improvePinOrder, swappableInputs, type PinOrders } from "./pin-order.js";
import type { ElkNode } from "elkjs";

export interface RenderOptions {
  mode?: Diagram["mode"];
  theme?: Diagram["theme"];
  layout?: Diagram["layout"];
}

export interface Netlist2SvgEngine {
  render(skin: string, netlist: Record<string, unknown>, done?: undefined, layout?: NetlistGraph): Promise<string>;
  dumpLayout?(skin: string, netlist: Record<string, unknown>, prelayout: boolean, done: (error: Error | null, result?: string) => void): void;
}

/** Compile CDL to the JSON/Skin pair expected by Netlist2SVG. */
export function compileSource(source: string, options: RenderOptions = {}) {
  const diagram = parse(source, { mode: options.mode });
  if (options.theme) diagram.theme = options.theme;
  if (options.layout) diagram.layout = options.layout;
  const { netlist,adapters } = compileNetlist(diagram,true);
  return { diagram,netlist,adapters,skin:generateSkin(diagram,diagram.theme,diagram.layout,undefined,adapters) };
}

async function readLayout(engine: Netlist2SvgEngine, skin: string, netlist: Record<string, unknown>): Promise<NetlistGraph> {
  const raw = await new Promise<string>((resolve, reject) => {
    engine.dumpLayout!(skin, netlist, true, (error, result) => {
      if (error) reject(error);
      else if (result === undefined) reject(new Error("Netlist2SVG returned no layout graph"));
      else resolve(result);
    });
  });
  return JSON.parse(raw) as NetlistGraph;
}

/** Prepare the skin and layout together: the selected pin coordinates must match. */
export async function prepareRender(compiled: ReturnType<typeof compileSource>, engine: Netlist2SvgEngine, elk?: PortLayouter, forceLayout = false) {
  const { diagram,netlist,skin } = compiled;
  const explicit = hasPlacedPorts(diagram);
  const boundary = explicit || (diagram.direction !== "LR" && !!Object.keys(diagram.ports).length);
  const reorder = swappableInputs(diagram).length > 0;
  if (!boundary && !reorder && !forceLayout) return { skin,layout:undefined };
  if (!engine.dumpLayout || !elk) {
    if (!explicit) return { skin,layout:undefined };
    throw new Error("Explicit diagram port placement requires Netlist2SVG with dumpLayout and an ELK layouter");
  }
  const route = async (orders?: PinOrders) => {
    const nextSkin = orders ? generateSkin(diagram,diagram.theme,diagram.layout,orders,compiled.adapters) : skin;
    const graph = await readLayout(engine,nextSkin,netlist);
    // Netlist2SVG emits ELK's legacy single-source/single-target edge format.
    const layout = boundary ? await placeInterfacePorts(diagram,graph,elk)
      : await elk.layout({ ...graph,layoutOptions:layoutOptions(diagram) } as unknown as ElkNode) as NetlistGraph;
    return { skin:nextSkin,layout };
  };
  const initial = await route();
  return reorder ? improvePinOrder(diagram,initial,route) : initial;
}

/** Return an SVG renderer backed by Netlist2SVG; usable in browsers or Node. */
export function createRenderer(engine: Netlist2SvgEngine, elk?: PortLayouter) {
  return async (source: string, options: RenderOptions = {}): Promise<string> => {
    const compiled = compileSource(source, options);
    const { skin,layout } = await prepareRender(compiled, engine, elk);
    return layout ? engine.render(skin, compiled.netlist, undefined, layout) : engine.render(skin, compiled.netlist);
  };
}
