import { parse } from "./parser.js";
import type { Diagram } from "./model.js";
import { yosysJson } from "./netlist.js";
import { generateSkin } from "./skin.js";

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
    const { netlist, skin } = compileSource(source, options);
    return engine.render(skin, netlist);
  };
}
