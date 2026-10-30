import { DiagramError, type Block, type Direction, type ParamValue, type Port, type Side } from "./model.js";

type Descriptor = [string, Direction, number];
const positive = (kind: string, key: string, params: Record<string, ParamValue>, fallback: number): number => {
  const value = params[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
};

export function builtinPorts(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  const width = kind === "DECODER" || kind === "ENCODER" ? 1 : positive(kind, "width", params, 32), addr = positive(kind, "addr_width", params, kind === "REGFILE" ? 5 : 12), op = positive(kind, "op_width", params, 4);
  const shamt = positive(kind, "shamt_width", params, Math.max(1, Math.ceil(Math.log2(width))));
  let desc: Descriptor[] | null = null;
  if (["ADD", "SUB", "AND", "OR", "XOR"].includes(kind)) desc = [["A", "input", width], ["B", "input", width], ["Y", "output", width]];
  else if (["SHIFT", "SHL", "SHR", "SAR"].includes(kind)) desc = [["A", "input", width], ["B", "input", shamt], ["Y", "output", width]];
  else if (kind === "NOT") desc = [["A", "input", width], ["Y", "output", width]];
  else if (kind === "MUX") {
    const n = positive(kind, "inputs", params, 2);
    if (n < 2 || n > 16) throw new Error("inputs for MUX must be between 2 and 16");
    const sel = Math.max(1, Math.ceil(Math.log2(n)));
    desc = [...Array.from({ length: n }, (_, i): Descriptor => [String.fromCharCode(65 + i), "input", width]), ["S", "input", sel], ["Y", "output", width]];
  }
  else if (kind === "DEMUX") {
    const n = positive(kind, "outputs", params, 2);
    if (n < 2 || n > 16) throw new Error("outputs for DEMUX must be between 2 and 16");
    const sel = Math.max(1, Math.ceil(Math.log2(n)));
    desc = [["A", "input", width], ["S", "input", sel], ...Array.from({ length: n }, (_, i): Descriptor => [`Y${i}`, "output", width])];
  }
  else if (kind === "DECODER") {
    const w = positive(kind, "width", params, 2);
    if (w > 8) throw new Error("width for DECODER must be at most 8");
    desc = [["A", "input", w], ["Y", "output", 2 ** w]];
  }
  else if (kind === "ENCODER") {
    const w = positive(kind, "width", params, 4);
    if (w < 2 || w > 256) throw new Error("width for ENCODER must be between 2 and 256");
    desc = [["A", "input", w], ["Y", "output", Math.max(1, Math.ceil(Math.log2(w)))], ["VALID", "output", 1]];
  }
  else if (kind === "FIFO") {
    positive(kind, "depth", params, 8);
    desc = [["DIN", "input", width], ["PUSH", "input", 1], ["FULL", "output", 1], ["DOUT", "output", width], ["POP", "input", 1], ["EMPTY", "output", 1], ["CLK", "input", 1]];
  }
  else if (kind === "DFF") desc = [["D", "input", width], ["CLK", "input", 1], ["Q", "output", width]];
  else if (kind === "CMP") desc = [["A", "input", width], ["B", "input", width], ["Y", "output", 1]];
  else if (kind === "ALU") desc = [["A", "input", width], ["B", "input", width], ["OP", "input", op], ["Y", "output", width]];
  else if (kind === "SRAM") desc = [["ADDR", "input", addr], ["WDATA", "input", width], ["WE", "input", 1], ["CLK", "input", 1], ["RDATA", "output", width]];
  else if (kind === "REGFILE") {
    const reads = positive(kind, "read_ports", params, 2), writes = positive(kind, "write_ports", params, 1);
    desc = [];
    for (let i = 0; i < reads; i++) desc.push([`RADDR${i}`, "input", addr]);
    for (let i = 0; i < writes; i++) desc.push([`WADDR${i}`, "input", addr], [`WDATA${i}`, "input", width], [`WE${i}`, "input", 1]);
    desc.push(["CLK", "input", 1]);
    for (let i = 0; i < reads; i++) desc.push([`RDATA${i}`, "output", width]);
  }
  if (!desc) return null;
  const known = new Set(["width", "addr_width", "op_width", "shamt_width", "op", "inputs", "outputs", "depth", "read_ports", "write_ports"]), used = new Set(["width", ...(kind === "SRAM" ? ["addr_width"] : []), ...(kind === "REGFILE" ? ["addr_width", "read_ports", "write_ports"] : []), ...(kind === "ALU" ? ["op_width"] : []), ...(kind === "CMP" ? ["op"] : []), ...(kind === "MUX" ? ["inputs"] : []), ...(kind === "DEMUX" ? ["outputs"] : []), ...(kind === "FIFO" ? ["depth"] : []), ...(["SHIFT", "SHL", "SHR", "SAR"].includes(kind) ? ["shamt_width"] : [])]);
  const extra = Object.keys(params).filter(k => !known.has(k)).sort();
  if (extra.length) throw new Error(`unsupported parameters for ${kind}: ${extra.join(", ")}`);
  if (kind === "CMP" && params.op !== undefined && !["eq", "ne"].includes(String(params.op))) throw new Error('op for CMP must be "eq" or "ne"');
  const unused = Object.keys(params).filter(k => !used.has(k)).sort();
  if (unused.length) throw new Error(`unused parameter for ${kind}: ${unused.join(", ")}`);
  const ports: Record<string, Port> = {};
  for (const [name, direction, bits] of desc) {
    const side: Side = (kind === "MUX" || kind === "DEMUX") && name === "S" ? "south" : kind === "ALU" && name === "OP" ? "north" : kind === "FIFO" ? (name === "CLK" ? "south" : ["DIN", "PUSH", "FULL"].includes(name) ? "west" : "east") : direction === "input" ? "west" : "east";
    ports[name] = { name, direction, width: bits, side, line };
  }
  return ports;
}

export function validatePreset(kind: string, params: Record<string, ParamValue>, line: number): Record<string, Port> | null {
  try { return builtinPorts(kind, params, line); }
  catch (e) { throw new DiagramError("E202", (e as Error).message, line); }
}

export function defaultStyle(block: Block): string {
  return block.style ?? (["ALU", "ADD", "SUB", "CMP", "AND", "OR", "XOR", "NOT", "DECODER", "ENCODER"].includes(block.type) ? "logic" : ["DFF", "SRAM", "FIFO", "REGFILE"].includes(block.type) ? "storage" : block.type === "MUX" || block.type === "DEMUX" ? "control" : "neutral");
}
