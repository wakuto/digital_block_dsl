import { DiagramError, type Block, type Direction, type ParamValue, type Port, type Side } from "./model.js";

type Descriptor = [string, Direction, number];
const positive = (kind: string, key: string, params: Record<string, ParamValue>, fallback: number): number => {
  const value = params[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
};

export function builtinPorts(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  const width = positive(kind, "width", params, 32), addr = positive(kind, "addr_width", params, 12), op = positive(kind, "op_width", params, 4);
  const shamt = positive(kind, "shamt_width", params, Math.max(1, Math.ceil(Math.log2(width))));
  let desc: Descriptor[] | null = null;
  if (["ADD", "SUB", "AND", "OR", "XOR"].includes(kind)) desc = [["A", "input", width], ["B", "input", width], ["Y", "output", width]];
  else if (["SHIFT", "SHL", "SHR", "SAR"].includes(kind)) desc = [["A", "input", width], ["B", "input", shamt], ["Y", "output", width]];
  else if (kind === "NOT") desc = [["A", "input", width], ["Y", "output", width]];
  else if (kind === "MUX") desc = [["A", "input", width], ["B", "input", width], ["S", "input", 1], ["Y", "output", width]];
  else if (kind === "DFF") desc = [["D", "input", width], ["CLK", "input", 1], ["Q", "output", width]];
  else if (kind === "CMP") desc = [["A", "input", width], ["B", "input", width], ["Y", "output", 1]];
  else if (kind === "ALU") desc = [["A", "input", width], ["B", "input", width], ["OP", "input", op], ["Y", "output", width]];
  else if (kind === "SRAM") desc = [["ADDR", "input", addr], ["WDATA", "input", width], ["WE", "input", 1], ["CLK", "input", 1], ["RDATA", "output", width]];
  if (!desc) return null;
  const known = new Set(["width", "addr_width", "op_width", "shamt_width"]), used = new Set(["width", ...(kind === "SRAM" ? ["addr_width"] : []), ...(kind === "ALU" ? ["op_width"] : []), ...(["SHIFT", "SHL", "SHR", "SAR"].includes(kind) ? ["shamt_width"] : [])]);
  const extra = Object.keys(params).filter(k => !known.has(k)).sort();
  if (extra.length) throw new Error(`unsupported parameters for ${kind}: ${extra.join(", ")}`);
  const unused = Object.keys(params).filter(k => !used.has(k)).sort();
  if (unused.length) throw new Error(`unused parameter for ${kind}: ${unused.join(", ")}`);
  const ports: Record<string, Port> = {};
  for (const [name, direction, bits] of desc) {
    const side: Side = kind === "MUX" && name === "S" ? "south" : kind === "ALU" && name === "OP" ? "north" : direction === "input" ? "west" : "east";
    ports[name] = { name, direction, width: bits, side, line };
  }
  return ports;
}

export function validatePreset(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  try { return builtinPorts(kind, params, line); }
  catch (e) { throw new DiagramError("E202", (e as Error).message, line); }
}

export function defaultStyle(block: Block): string {
  return block.style ?? (["ALU", "ADD", "SUB", "CMP", "AND", "OR", "XOR", "NOT"].includes(block.type) ? "logic" : ["DFF", "SRAM"].includes(block.type) ? "storage" : block.type === "MUX" ? "control" : "neutral");
}
