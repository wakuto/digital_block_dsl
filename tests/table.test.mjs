import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, generateSkin } from "../dist/index.js";
import { renderSvg } from "../dist/node.js";

const source = spec => `version 1 diagram "test" {
  memory: box "タグアレイ" { ${spec} in INDEX[8]@west out TAG[20]@south }
}`;

test("table display is independent of logical port widths", () => {
  const d = parse(source('table(columns="タグ|データ", rows=5, ellipsis=on, brace="行", indices="0|1|2||n−1")'));
  assert.deepEqual(d.blocks.memory.table, {
    columns: ["タグ", "データ"], rows: 5, ellipsis: true, brace: "行", indices: ["0", "1", "2", "", "n−1"],
  });
  assert.equal(d.blocks.memory.ports.TAG.width, 20);
  const skin = generateSkin(d);
  assert.equal((skin.match(/r="2.3"/g) ?? []).length, 6);
  assert.match(skin, /n−1/);
  assert.match(skin, /s:pid="TAG"/);
});

test("invalid table options fail at the declaration", () => {
  for (const spec of [
    'table(rows=0)', 'table(rows=65)', 'table(rows="five")',
    'table(rows=2, ellipsis=on)', 'table(ellipsis=yes)', 'table(columns=3)',
    'table(rows=3, indices="0|1")', 'table(unknown=1)',
    'table() table()',
  ]) assert.throws(() => parse(source(spec)), /E202|E102/);
  assert.throws(() => parse('version 1 diagram "test" { x: ADD { table() } }'), /only supported inside box/);
});

test("table text is escaped in SVG", () => {
  const skin = generateSkin(parse(source('table(columns="<tag>|A&B", brace="<rows>")')));
  assert.match(skin, /&lt;tag&gt;/);
  assert.match(skin, /A&amp;B/);
  assert.match(skin, /&lt;rows&gt;/);
});

test("ordinary boxes retain their existing representation", () => {
  const d = parse(source(''));
  assert.equal(d.blocks.memory.table, undefined);
  assert.match(generateSkin(d), /rx="4"/);
});

for (const name of ["set_associative_cache", "tlb"]) {
  test(`${name} renders with the actual Netlist2SVG engine`, async () => {
    const text = await readFile(new URL(`../examples/${name}.cdl`, import.meta.url), "utf8");
    const svg = await renderSvg(text);
    assert.match(svg, /<svg/);
    assert.match(svg, /class="symbol cell_tags"/);
    assert.match(svg, /タグアレイ/);
    assert.doesNotMatch(svg, /NaN|undefined/);
  });
}
