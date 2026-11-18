import { createRequire } from "node:module";
import { compileSource, createRenderer, prepareRender } from "./render-core.js";
import type { Netlist2SvgEngine, RenderOptions } from "./render-core.js";
import type { ELK } from "elkjs";
import { embedDrawio } from "./drawio.js";
import { widthLabelEdges } from "./drawio-routes.js";
import { PALETTES } from "./skin.js";

const require = createRequire(import.meta.url);
const netlist2svg = require("netlist2svg") as Netlist2SvgEngine;
const Elk = require("elkjs") as new () => ELK;
const elk = new Elk();
const renderWithNetlist2Svg = createRenderer(netlist2svg, elk);

/** Compile the netlist/skin pair and its fixed layout when positioning diagram ports. */
export async function bundleSource(source: string, options: RenderOptions = {}) {
  const compiled = compileSource(source, options);
  return { ...compiled, ...await prepareRender(compiled, netlist2svg, elk) };
}

/** Parse CDL and return the rendered SVG string using Netlist2SVG. */
export function renderSvg(source: string, options: RenderOptions = {}): Promise<string> {
  return renderWithNetlist2Svg(source, options);
}

/** Render an SVG with an editable draw.io model embedded in the root element. */
export async function renderDrawioSvg(source:string, options:RenderOptions = {}):Promise<string> {
  const compiled=compileSource(source,options);
  const {skin,layout}=await prepareRender(compiled,netlist2svg,elk,true);
  if(!layout)throw new Error("draw.io export requires layout data");
  // Netlist2SVG decodes skin entities but its XML serializer does not re-escape them.
  const escapedSkin=skin.replace(/&(?:amp|lt|gt|quot|apos);/g,entity=>"&amp;"+entity.slice(1));
  const widthLabels=widthLabelEdges(layout.edges);
  const preview=structuredClone(layout);
  for(const edge of preview.edges)if(!widthLabels.has(edge.id))delete edge.labels;
  const svg=await netlist2svg.render(escapedSkin,compiled.netlist,undefined,preview);
  return embedDrawio(svg,layout,compiled.diagram,PALETTES[compiled.diagram.theme],widthLabels);
}
