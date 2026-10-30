import { parse } from "./parser.js";
import type { Diagram } from "./model.js";
import { yosysJson } from "./netlist.js";
import { generateSkin, PALETTES } from "./skin.js";

export interface RenderOptions {
  theme?: Diagram["theme"];
  layout?: Diagram["layout"];
}

export interface Netlist2SvgEngine {
  render(skin: string, netlist: Record<string, unknown>): Promise<string>;
}

/** Compile CDL to the JSON/Skin pair expected by Netlist2SVG. */
export function compileSource(source: string, options: RenderOptions = {}) {
  const diagram = parse(source);
  if (options.theme) diagram.theme = options.theme;
  if (options.layout) diagram.layout = options.layout;
  return { diagram, netlist: yosysJson(diagram, true), skin: generateSkin(diagram) };
}

/** Return an SVG renderer backed by Netlist2SVG; usable in browsers or Node. */
export function createRenderer(engine: Netlist2SvgEngine) {
  return async (source: string, options: RenderOptions = {}): Promise<string> => {
    const { diagram, netlist, skin } = compileSource(source, options);
    return drawGroups(await engine.render(skin, netlist), diagram);
  };
}

/** Draw a labelled dashed frame around the rendered cells of each `group`. */
export function drawGroups(svg: string, diagram: Diagram): string {
  if (!diagram.groups.length) return svg;
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
