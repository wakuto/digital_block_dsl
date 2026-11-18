import { parse } from "./parser.js";
import type { Diagram } from "./model.js";
import { compileNetlist } from "./netlist.js";
import { generateSkin, layoutOptions, PALETTES } from "./skin.js";
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
    const svg = await (layout ? engine.render(skin, compiled.netlist, undefined, layout) : engine.render(skin, compiled.netlist));
    return drawGroups(svg, compiled.diagram);
  };
}

/** Draw a labelled dashed frame around the rendered cells of each `group`. */
export function drawGroups(svg: string, diagram: Diagram): string {
  if (!diagram.groups?.length) return svg;
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const m of svg.matchAll(/<g s:type="cdiag_[^"]*" transform="translate\(([-\d.]+),([-\d.]+)\)" s:width="([\d.]+)" s:height="([\d.]+)" id="cell_([^"]+)"/g))
    boxes.set(m[5], { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
  const size = /^<svg[^>]*?width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  let width = Number(size?.[1] ?? 0), height = Number(size?.[2] ?? 0);
  const ink = PALETTES[diagram.theme].ink, pad = 12, top = 26;
  let frames = "";
  for (const g of diagram.groups) {
    const cells = g.members.map(id => boxes.get(id)).filter(b => b !== undefined);
    if (!cells.length) continue;
    const x = Math.max(1, Math.min(...cells.map(b => b.x)) - pad), y = Math.max(1, Math.min(...cells.map(b => b.y)) - top);
    const r = Math.max(...cells.map(b => b.x + b.w)) + pad, bottom = Math.max(...cells.map(b => b.y + b.h)) + pad;
    width = Math.max(width, r + 1); height = Math.max(height, bottom + 1);
    const label = g.label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    frames += `<g class="cdiag-group"><rect x="${x}" y="${y}" width="${r - x}" height="${bottom - y}" rx="6" fill="none" stroke="${ink}" stroke-width="1" stroke-dasharray="6 4" opacity="0.7"/><text x="${x + 8}" y="${y + 15}" font-size="12" font-weight="bold" fill="${ink}" stroke="none">${label}</text></g>`;
  }
  return svg.replace(/^(<svg[^>]*?)width="[\d.]+" height="[\d.]+"/, `$1width="${width}" height="${height}"`).replace("</style>", `</style>${frames}`);
}
