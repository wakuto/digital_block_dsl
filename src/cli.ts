#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "./parser.js";
import { yosysJson } from "./netlist.js";
import { DiagramError } from "./model.js";
import { bundleSource, renderDrawioSvg, renderSvg } from "./node.js";

async function main(args: string[]): Promise<number> {
  const [command, source, ...rest] = args;
  if (!command || !source || !["check", "dump-ir", "dump-netlist", "bundle", "render"].includes(command)) {
    process.stderr.write("Usage: cdiag <check|dump-ir|dump-netlist> FILE.cdl [-o OUTPUT] [--mode circuit|microarchitecture]\n       cdiag bundle FILE.cdl -o BASENAME [--mode circuit|microarchitecture]\n       cdiag render FILE.cdl -o OUTPUT.svg [--theme light|dark|mono] [--layout compact|balanced|feedback] [--mode circuit|microarchitecture]\n       Use OUTPUT.drawio.svg to include an editable draw.io diagram.\n"); return 2;
  }
  try {
    const modeFlag=rest.indexOf("--mode");const modeValue=modeFlag>=0?rest[modeFlag+1]:undefined;
    if(modeFlag>=0&&(!modeValue||modeValue.startsWith("--")))throw new DiagramError("E202","--mode requires circuit or microarchitecture");
    if(modeValue!==undefined&&modeValue!=="circuit"&&modeValue!=="microarchitecture")throw new DiagramError("E202",`invalid mode: ${modeValue}`);
    const text = await readFile(source, "utf8");
    const diagram = parse(text,{mode:modeValue});
    if (command === "check") {
      process.stdout.write(`OK: ${diagram.title} (${Object.keys(diagram.blocks).length} blocks, ${diagram.nets.length} nets)\n`); return 0;
    }
    const outputFlag = rest.indexOf("-o") >= 0 ? rest.indexOf("-o") : rest.indexOf("--output");
    const output = outputFlag >= 0 ? rest[outputFlag + 1] : undefined;
    if (command === "render") {
      if (!output) throw new DiagramError("E307", "render requires -o OUTPUT.svg");
      const themeFlag = rest.indexOf("--theme"), layoutFlag = rest.indexOf("--layout");
      if (themeFlag >= 0) {
        const value = rest[themeFlag + 1];
        if (!("light dark mono".split(" ").includes(value))) throw new DiagramError("E202", `invalid theme: ${value}`);
        diagram.theme = value as typeof diagram.theme;
      }
      if (layoutFlag >= 0) {
        const value = rest[layoutFlag + 1];
        if (!("balanced compact feedback".split(" ").includes(value))) throw new DiagramError("E202", `invalid layout preset: ${value}`);
        diagram.layout = value as typeof diagram.layout;
      }
      const drawio=/\.drawio\.svg$/i.test(output);
      const render=drawio?renderDrawioSvg:renderSvg;
      const svg=await render(text,{theme:diagram.theme,layout:diagram.layout,mode:diagram.mode});
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output,svg,"utf8");
      process.stdout.write(`${drawio?"Rendered editable draw.io SVG":"Rendered with Netlist2SVG"}: ${output}\n`); return 0;
    }
    if (command === "bundle") {
      const base = output ?? (source.replace(/\.cdl$/i, ""));
      const { netlist, skin, layout } = await bundleSource(text, { mode: diagram.mode });
      await mkdir(dirname(base), { recursive: true });
      await writeFile(`${base}.json`, `${JSON.stringify(netlist, null, 2)}\n`, "utf8");
      await writeFile(`${base}.skin.svg`, skin, "utf8");
      if (layout) await writeFile(`${base}.layout.json`, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
      process.stdout.write(`Wrote Netlist2SVG bundle: ${base}.json and ${base}.skin.svg${layout ? ` with ${base}.layout.json` : ""}\n`); return 0;
    }
    const value = command === "dump-ir" ? diagram : yosysJson(diagram);
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, json, "utf8"); } else process.stdout.write(json);
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`); return error instanceof DiagramError ? 1 : 2;
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; });
