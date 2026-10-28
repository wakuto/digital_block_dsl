import { createRequire } from "node:module";
import { createRenderer } from "./render-core.js";
import type { Netlist2SvgEngine, RenderOptions } from "./render-core.js";

const require = createRequire(import.meta.url);
const netlist2svg = require("netlist2svg") as Netlist2SvgEngine;
const renderWithNetlist2Svg = createRenderer(netlist2svg);

/** Parse CDL and return the rendered SVG string using Netlist2SVG. */
export function renderSvg(source: string, options: RenderOptions = {}): Promise<string> {
  return renderWithNetlist2Svg(source, options);
}
