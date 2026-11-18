import { DiagramError, type Block, type Direction, type ParamValue, type Port, type Side } from "./model.js";

type Descriptor = [string, Direction, number];
const positive = (kind: string, key: string, params: Record<string, ParamValue>, fallback: number): number => {
  const value = params[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
};

function standardDescriptors(kind: string, params: Record<string, ParamValue>): Descriptor[] | null {
  const width = positive(kind, "width", params, 32), addr = positive(kind, "addr_width", params, 12), op = positive(kind, "op_width", params, 4);
  const shamt = positive(kind, "shamt_width", params, Math.max(1, Math.ceil(Math.log2(width))));
  let desc: Descriptor[] | null = null;
  if (["ADD", "SUB", "AND", "OR", "XOR"].includes(kind)) desc = [["A", "input", width], ["B", "input", width], ["Y", "output", width]];
  else if (["SHIFT", "SHL", "SHR", "SAR"].includes(kind)) desc = [["A", "input", width], ["B", "input", shamt], ["Y", "output", width]];
  else if (kind === "NOT") desc = [["A", "input", width], ["Y", "output", width]];
  else if (kind === "MUX") {
    const inputs = positive(kind, "inputs", params, 2);
    if (inputs < 2 || inputs > 16) throw new Error("inputs for MUX must be between 2 and 16");
    desc = [
      ...Array.from({ length: inputs }, (_, i): Descriptor => [String.fromCharCode(65 + i), "input", width]),
      ["S", "input", Math.ceil(Math.log2(inputs))], ["Y", "output", width],
    ];
  }
  else if (kind === "DFF") desc = [["D", "input", width], ["CLK", "input", 1], ["Q", "output", width]];
  else if (kind === "CMP") desc = [["A", "input", width], ["B", "input", width], ["Y", "output", 1]];
  else if (kind === "ALU") desc = [["A", "input", width], ["B", "input", width], ["OP", "input", op], ["Y", "output", width]];
  else if (kind === "SRAM") desc = [["ADDR", "input", addr], ["WDATA", "input", width], ["WE", "input", 1], ["CLK", "input", 1], ["RDATA", "output", width]];
  if (!desc) return null;
  const known = new Set(["width", "addr_width", "op_width", "shamt_width", "op", "inputs"]), used = new Set(["width", ...(kind === "SRAM" ? ["addr_width"] : []), ...(kind === "ALU" ? ["op_width"] : []), ...(kind === "CMP" ? ["op"] : []), ...(kind === "MUX" ? ["inputs"] : []), ...(["SHIFT", "SHL", "SHR", "SAR"].includes(kind) ? ["shamt_width"] : [])]);
  const extra = Object.keys(params).filter(k => !known.has(k)).sort();
  if (extra.length) throw new Error(`unsupported parameters for ${kind}: ${extra.join(", ")}`);
  if (kind === "CMP" && params.op !== undefined && !["eq", "ne"].includes(String(params.op))) throw new Error('op for CMP must be "eq" or "ne"');
  const unused = Object.keys(params).filter(k => !used.has(k)).sort();
  if (unused.length) throw new Error(`unused parameter for ${kind}: ${unused.join(", ")}`);
  return desc;
}

function selectionDescriptors(kind: "MATCH" | "PRIORITY", params: Record<string, ParamValue>, line: number): Descriptor[] {
  const allowed = kind === "MATCH" ? ["entries", "width"] : ["entries"];
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("unsupported parameter for " + kind);
  const entries = positive(kind, "entries", params, 8);
  if (!Number.isSafeInteger(entries)) throw new Error("entries must be a positive integer");
  if (kind === "MATCH") {
    const width = positive(kind, "width", params, 8);
    if (!Number.isSafeInteger(width)) throw new Error("width must be a positive integer");
    if (entries * width > 65536) throw new DiagramError("E204", "generated match vector exceeds 65536 bits", line);
    return [["QUERY", "input", width], ["DATA", "input", entries * width], ["MATCH", "output", entries]];
  }
  if (entries > 65536) throw new DiagramError("E204", "PRIORITY mask exceeds 65536 bits", line);
  return [["MATCH", "input", entries], ["INDEX", "output", Math.max(1, Math.ceil(Math.log2(entries)))], ["VALID", "output", 1]];
}

export function builtinPorts(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  const desc = kind === "MATCH" || kind === "PRIORITY"
    ? selectionDescriptors(kind, params, line)
    : standardDescriptors(kind, params);
  if (!desc) return null;
  const ports: Record<string, Port> = {};
  for (const [name, direction, bits] of desc) {
    const side: Side = kind === "MUX" && name === "S" ? "south" : kind === "ALU" && name === "OP" ? "north" : direction === "input" ? "west" : "east";
    ports[name] = { name, direction, width: bits, side, line };
  }
  return ports;
}

export function validatePreset(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  try { return builtinPorts(kind, params, line); }
  catch (e) {
    if (e instanceof DiagramError) throw e;
    throw new DiagramError("E202", (e as Error).message, line);
  }
}

export function defaultStyle(block: Block): string {
  return block.style ?? (["ALU", "ADD", "SUB", "CMP", "AND", "OR", "XOR", "NOT"].includes(block.type) ? "logic" : ["DFF", "SRAM"].includes(block.type) ? "storage" : block.type === "MUX" ? "control" : "neutral");
}
