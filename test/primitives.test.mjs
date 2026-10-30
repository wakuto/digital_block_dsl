import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse, generateSkin } from "../dist/index.js";
import { renderSvg } from "../dist/node.js";

const wrap = body => `version 1\ndiagram "t" {\n${body}\n}\n`;
const block = (decl, id = "b") => parse(wrap(decl)).blocks[id];
const names = b => Object.keys(b.ports);

test("MUX, AND and OR take an inputs count", () => {
  assert.deepEqual(names(block("b: MUX(width=8, inputs=4)")), ["A", "B", "C", "D", "S", "Y"]);
  assert.equal(block("b: MUX(width=8, inputs=4)").ports.S.width, 2);
  assert.deepEqual(names(block("b: AND(width=1, inputs=3)")), ["A", "B", "C", "Y"]);
  assert.deepEqual(names(block("b: OR(inputs=4)")), ["A", "B", "C", "D", "Y"]);
  assert.deepEqual(names(block("b: MUX(width=8)")), ["A", "B", "S", "Y"]);
});

test("DEMUX, DECODER, ENCODER and FIFO build their ports", () => {
  assert.deepEqual(names(block("b: DEMUX(width=8, outputs=3)")), ["A", "S", "Y0", "Y1", "Y2"]);
  const dec = block("b: DECODER(width=3)");
  assert.equal(dec.ports.A.width, 3);
  assert.equal(dec.ports.Y.width, 8);
  const enc = block("b: ENCODER(width=8)");
  assert.equal(enc.ports.Y.width, 3);
  assert.equal(enc.ports.VALID.width, 1);
  const fifo = block("b: FIFO(width=16, depth=4)");
  assert.deepEqual(names(fifo).sort(), ["CLK", "DIN", "DOUT", "EMPTY", "FULL", "POP", "PUSH"]);
  assert.equal(fifo.ports.FULL.side, "west");
  assert.equal(fifo.ports.EMPTY.side, "east");
});

test("out-of-range or unused parameters are rejected", () => {
  for (const decl of ["b: MUX(inputs=1)", "b: AND(inputs=17)", "b: DEMUX(outputs=1)", "b: DECODER(width=9)", "b: ENCODER(width=1)", "b: FIFO(depth=0)", "b: XOR(inputs=3)", "b: FIFO(inputs=2)"])
    assert.throws(() => parse(wrap(decl)), /E202/, decl);
});

test("orientation marks set rotation and flips", () => {
  const b = block("b: ADD(width=8) @90 @flipx @flipy");
  assert.equal(b.rotation, 90);
  assert.equal(b.flipX, true);
  assert.equal(b.flipY, true);
  const c = block(`b: box "B" {\n rotate 180\n flipx\n in A\n out Y\n}`);
  assert.equal(c.rotation, 180);
  assert.equal(c.flipX, true);
  assert.equal(block("b: ADD(width=8)").rotation, 0);
  assert.throws(() => parse(wrap("b: ADD(width=8) @45")), /rotation/);
  assert.throws(() => parse(wrap("b: ADD(width=8) @up")), /flipx/);
});

const pins = (skin, id) => {
  const seg = skin.split(`id="cell_${id}"`)[1].split('id="cell_')[0];
  return Object.fromEntries([...seg.matchAll(/s:x="([\d.]+)" s:y="([\d.]+)" s:pid="(\w+)"/g)].map(m => [m[3], { x: Number(m[1]), y: Number(m[2]) }]));
};

test("rotation and flips keep the reading order of ports along an edge", () => {
  const decl = `box "B" { in A[8], B[8], C[8]\n out X[8] }`;
  const skin = generateSkin(parse(wrap(["p", "r90", "r180", "r270", "fy", "fx"].map((id, i) => `${id}: ${decl.replace("box \"B\"", `box "B" ${["", "@90", "@180", "@270", "@flipy", "@flipx"][i]}`)}`).join("\n"))));
  const p = id => pins(skin, id);
  const leftToRight = q => q.A.x < q.B.x && q.B.x < q.C.x, topToBottom = q => q.A.y < q.B.y && q.B.y < q.C.y;
  assert.ok(topToBottom(p("p")));
  assert.ok(leftToRight(p("r90")) && p("r90").A.y === 0);
  assert.ok(topToBottom(p("r180")) && p("r180").A.x > 0);
  assert.ok(leftToRight(p("r270")) && p("r270").A.y > 0);
  assert.ok(topToBottom(p("fy")) && p("fy").X.x > 0);
  assert.ok(topToBottom(p("fx")) && p("fx").A.x > 0 && p("fx").X.x === 0);
});

test("a flipped MUX moves its select to the other edge", () => {
  const skin = generateSkin(parse(wrap("m: MUX(width=8, inputs=4)\nf: MUX(width=8, inputs=4) @flipy")));
  assert.ok(pins(skin, "m").S.y > 60);
  assert.equal(pins(skin, "f").S.y < 60, true);
});

test("every example renders to an SVG", async () => {
  for (const f of readdirSync("examples").filter(f => f.endsWith(".cdl"))) {
    const svg = await renderSvg(readFileSync(`examples/${f}`, "utf8"));
    assert.match(svg, /^<svg[\s>]/, f);
  }
});
