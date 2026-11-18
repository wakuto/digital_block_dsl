import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse, yosysJson } from "../dist/index.js";
import { bundleSource, renderSvg } from "../dist/node.js";

function svgSymbol(svg, name) {
  const group = new RegExp(`<g ([^>]*id="cell_${name}"[^>]*)>([\\s\\S]*?)</g>`).exec(svg);
  assert.ok(group, `missing SVG symbol ${name}`);
  const [x, y] = group[1].match(/translate\(([^,]+),([^)]+)\)/).slice(1).map(Number);
  const width = Number(group[1].match(/s:width="([^"]+)"/)[1]);
  const height = Number(group[1].match(/s:height="([^"]+)"/)[1]);
  const pin = group[2].match(/<g s:x="([^"]+)" s:y="([^"]+)" s:pid="[AY]"/);
  return { x, y, width, height, pin: pin && pin.slice(1).map(Number) };
}

test("external symbols follow all four diagram directions when no side is specified", async () => {
  const cases = [
    ["LR", "x", 1, [30, 10], [0, 10]],
    ["RL", "x", -1, [0, 10], [30, 10]],
    ["TB", "y", 1, [10, 30], [10, 0]],
    ["BT", "y", -1, [10, 0], [10, 30]],
  ];
  for (const [direction, axis, sign, inputPin, outputPin] of cases) {
    const svg = await renderSvg(`version 1 diagram "flow" {
      direction ${direction} input src[1] output dst[1]
      body: NOT(width=1) src -> body.A body.Y -> dst
    }`);
    const src = svgSymbol(svg, "src"), body = svgSymbol(svg, "body"), dst = svgSymbol(svg, "dst");
    assert.deepEqual(src.pin, inputPin, direction);
    assert.deepEqual(dst.pin, outputPin, direction);
    assert.ok((body[axis] - src[axis]) * sign > 0 && (dst[axis] - body[axis]) * sign > 0, direction);
  }
});

test("explicit sides place symbols outside the datapath and route wires to their tips", async () => {
  const source = await readFile(new URL("../examples/microarchitecture_vertical_ports.cdl", import.meta.url), "utf8");
  const svg = await renderSvg(source);
  const values = svgSymbol(svg, "values"), select = svgSymbol(svg, "select");
  const north = svgSymbol(svg, "fill_data"), west = svgSymbol(svg, "index");
  const south = svgSymbol(svg, "data"), east = svgSymbol(svg, "valid");
  assert.ok(north.y + north.height < values.y);
  assert.ok(west.x + west.width < Math.min(values.x, select.x));
  assert.ok(south.y > select.y + select.height);
  assert.ok(east.x > Math.max(values.x + values.width, select.x + select.width));
  assert.deepEqual([north.pin, west.pin, south.pin, east.pin], [[10, 30], [30, 10], [10, 0], [0, 10]]);
  const points = new Set([...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)]
    .flatMap(([, x1, y1, x2, y2]) => [`${x1},${y1}`, `${x2},${y2}`]));
  for (const { x, y, pin } of [north, west, south, east]) {
    assert.ok(points.has(`${x + pin[0]},${y + pin[1]}`), "wire reaches the port tip");
  }
});

test("a direct link between explicit diagram ports survives SVG bundling", async () => {
  const source = `version 1 diagram "direct" { input src[4]@west output dst[4]@south src -> dst }`;
  const raw = yosysJson(parse(source)).modules.top;
  assert.equal(raw.ports.src.direction, "input");
  assert.equal(raw.ports.dst.direction, "output");
  assert.deepEqual(raw.ports.src.bits, raw.ports.dst.bits);
  const { layout } = await bundleSource(source);
  assert.equal(layout.edges.length, 1);
  const sections = layout.edges[0].sections;
  assert.ok(sections.length && sections.every(({ startPoint, endPoint }) =>
    [startPoint.x, startPoint.y, endPoint.x, endPoint.y].every(Number.isFinite)));
  for (let i = 1; i < sections.length; i++) assert.deepEqual(sections[i-1].endPoint, sections[i].startPoint);
});

test("bit selections and concatenations follow diagram flow and retain their bit order", async () => {
  for(const [flow,axis,entry,exit] of [["TB",1,0,1],["BT",1,1,0],["RL",0,1,0]]){
    const source=`version 1 diagram "Slice and join" {
      direction ${flow}
      input bus[12], low[4]
      output picked[4], packet[8]
      bus[11:8] -> picked
      net packed[8] = {bus[7:4], low} -> packet
    }`;
    const svg=await renderSvg(source);
    const wires=new Set([...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" class="net_/g)]
      .flatMap(([,x1,y1,x2,y2])=>[`${x1},${y1}`,`${x2},${y2}`]));
    for(const kind of ["split","join"]){
      const [,attrs,body]=svg.match(new RegExp(`<g (s:type="cdiag_bus_${kind}"[^>]*)>([\\s\\S]*?)</g>`))??[];
      assert.ok(body,`${flow} ${kind} exists`);
      const origin=attrs.match(/translate\(([^,]+),([^)]+)\)/).slice(1).map(Number);
      const size=["width","height"].map(attr=>Number(attrs.match(new RegExp(`s:${attr}="([^"]+)"`))[1]));
      const bar=body.match(/<rect [^>]*width="([^"]+)" height="([^"]+)" class="splitjoinBody"/).slice(1).map(Number);
      assert.equal(bar[axis],5);
      assert.ok(bar[1-axis]>5);
      const pins=Object.fromEntries([...body.matchAll(/<g s:x="([^"]+)" s:y="([^"]+)" s:pid="([^"]+)"/g)]
        .map(([,x,y,name])=>[name,[Number(x),Number(y)]]));
      assert.equal(Object.keys(pins).length,3);
      for(const [name,xy] of Object.entries(pins)){
        assert.equal(xy[axis],(name.startsWith("A")?entry:exit)*size[axis],`${kind}.${name}`);
        assert.ok(wires.has(`${origin[0]+xy[0]},${origin[1]+xy[1]}`),"wire reaches rotated pin");
      }
      assert.match(body,kind==="split"?/>11:8<\/text>[\s\S]*>7:4<\/text>/:/>7:4<\/text>[\s\S]*>3:0<\/text>/);
    }
    const raw=yosysJson(parse(source)).modules.top.ports;
    assert.deepEqual(raw.packet.bits,[...raw.low.bits,...raw.bus.bits.slice(4,8)]);
  }
});
