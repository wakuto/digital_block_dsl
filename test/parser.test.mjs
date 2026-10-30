import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse, yosysJson, generateSkin, drawGroups } from "../dist/index.js";

const wrap = body => `version 1\ndiagram "t" {\n${body}\n}\n`;

test("every example passes check", () => {
  for (const f of readdirSync("examples").filter(f => f.endsWith(".cdl"))) parse(readFileSync(`examples/${f}`, "utf8"));
});

test("a statement may start with a concatenation", () => {
  const d = parse(wrap(`input a[4], b[4]\noutput y[8]\n{a, b} -> y`));
  assert.deepEqual(d.wirings[0].sources.map(s => s.endpoint), ["a", "b"]);
  assert.equal(d.wirings[0].width, 8);
});

test("a leading concatenation into a block port infers the port width", () => {
  const d = parse(wrap(`x: box "X" { out Y[8] }\ninput b[8]\nr: DFF(width=16)\n{x.Y, b} -> r.D`));
  assert.equal(d.wirings[0].width, 16);
});

test("rank from a statement and a block body reaches the ELK partition", () => {
  const d = parse(wrap(`a: box "A" { in I out O }\nb: box "B" { rank 1 in I out O }\nrank 0: a\na.O -> b.I\nb.O -> a.I`));
  assert.equal(d.blocks.a.rank, 0);
  assert.equal(d.blocks.b.rank, 1);
  const cells = yosysJson(d, true).modules.top.cells;
  assert.equal(cells.b.attributes["org.eclipse.elk.partitioning.partition"], 1);
  assert.match(generateSkin(d), /org\.eclipse\.elk\.partitioning\.activate="true"/);
});

test("diagrams without rank keep partitioning off", () => {
  const d = parse(wrap(`input a\noutput y\nn: NOT(width=1)\na -> n.A\nn.Y -> y`));
  assert.doesNotMatch(generateSkin(d), /partitioning/);
  assert.equal("org.eclipse.elk.partitioning.partition" in yosysJson(d, true).modules.top.cells.n.attributes, false);
});

test("rank and group are still usable as identifiers", () => {
  const d = parse(wrap(`input rank[1], group[1]\noutput y[2]\n{rank, group} -> y`));
  assert.equal(d.wirings[0].width, 2);
});

test("rank errors: unknown block, diagram port, conflict", () => {
  assert.throws(() => parse(wrap(`input a\nrank 0: nope`)), /E101.*unknown block/);
  assert.throws(() => parse(wrap(`input a\nrank 0: a`)), /E101.*blocks only/);
  assert.throws(() => parse(wrap(`b: box "B" { rank 1 in I }\nrank 2: b`)), /E106/);
});

test("group members must be distinct blocks", () => {
  assert.throws(() => parse(wrap(`group "G": nope`)), /E101/);
  assert.throws(() => parse(wrap(`b: box "B" { in I }\ngroup "G": b, b`)), /E102/);
});

test("drawGroups frames the member cells and grows the canvas", () => {
  const d = parse(wrap(`a: box "A" { in I }\nb: box "B" { in I }\ngroup "Stage <1>": a, b`));
  const svg = `<svg xmlns="x" width="100" height="50"><style></style>`
    + `<g s:type="cdiag_a" transform="translate(10,40)" s:width="30" s:height="20" id="cell_a"></g>`
    + `<g s:type="cdiag_b" transform="translate(60,40)" s:width="40" s:height="20" id="cell_b"></g></svg>`;
  const out = drawGroups(svg, d);
  assert.match(out, /<rect x="1" y="14" width="111" height="58"/);
  assert.match(out, /Stage &lt;1&gt;/);
  assert.match(out, /width="113" height="73"/);
});

test("south port labels stay inside a box and do not overlap", () => {
  const d = parse(wrap(`bank: box "Bank" { in RDATA0[64]@south, RDATA1[64]@south, RADDR0[5]@south, RADDR1[5]@south }`));
  const skin = generateSkin(d);
  const g = /<g s:type="cdiag_bank"[^>]*s:width="(\d+)" s:height="(\d+)"/.exec(skin);
  const [w, h] = [Number(g[1]), Number(g[2])];
  const xs = [];
  for (const m of skin.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle" font-size="10"[^>]*>(R\w+)<\/text>/g)) {
    assert.ok(Number(m[2]) < h && Number(m[2]) > h / 2, `${m[3]} label y=${m[2]} outside box height ${h}`);
    xs.push(Number(m[1]));
  }
  assert.equal(xs.length, 4);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 6 * 6.2, `labels overlap at pitch ${xs[i] - xs[i - 1]} (w=${w})`);
});

test("REGFILE builds read and write ports", () => {
  const d = parse(wrap(`rf: REGFILE(width=64, read_ports=3, write_ports=2)`));
  const ports = d.blocks.rf.ports;
  assert.deepEqual(Object.keys(ports).sort(), ["CLK", "RADDR0", "RADDR1", "RADDR2", "RDATA0", "RDATA1", "RDATA2", "WADDR0", "WADDR1", "WDATA0", "WDATA1", "WE0", "WE1"]);
  assert.equal(ports.RADDR0.width, 5);
  assert.equal(ports.RDATA2.width, 64);
  assert.equal(ports.RDATA2.direction, "output");
  assert.throws(() => parse(wrap(`s: SRAM(read_ports=2)`)), /E202/);
});
