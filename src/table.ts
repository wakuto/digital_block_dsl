import { DiagramError, type ParamValue, type Table } from "./model.js";

/** Display rows are illustrative, independent of the memory's logical capacity. */
export function parseTable(params: Record<string, ParamValue>, line: number): Table {
  const fail = (message: string): never => { throw new DiagramError("E202", message, line); };
  for (const key of Object.keys(params)) {
    if (!["columns", "rows", "ellipsis", "brace", "indices"].includes(key)) fail(`unsupported table parameter: ${key}`);
  }
  const string = (key: string, fallback: string): string => {
    const value = params[key] ?? fallback;
    if (typeof value !== "string") return fail(`table ${key} must be a string`);
    return value;
  };
  const rows = params.rows ?? 1;
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1 || rows > 64) fail("table rows must be an integer from 1 to 64");
  const ellipsis = string("ellipsis", "off");
  if (!["on", "off"].includes(ellipsis)) fail("table ellipsis must be on or off");
  if (ellipsis === "on" && (rows as number) < 3) fail("table ellipsis requires at least three display rows");
  const columns = string("columns", "").split("|").map(s => s.trim());
  if (columns.length > 16) fail("table supports at most 16 columns");
  const indices = string("indices", "").split("|").map(s => s.trim());
  if (params.indices !== undefined && indices.length !== rows) fail("table indices must have one label per display row");
  return { columns, rows: rows as number, ellipsis: ellipsis === "on", brace: params.brace === undefined ? null : string("brace", ""), indices: params.indices === undefined ? [] : indices };
}

/** Approximate glyph width, including full-width Japanese labels. */
export const textWidth = (text: string): number => Array.from(text).reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 13 : 7.5), 0);
