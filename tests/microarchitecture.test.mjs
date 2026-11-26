import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { compileSource, parse, generateSkin, yosysJson } from "../dist/index.js";
import { bundleSource, renderSvg } from "../dist/node.js";

const tableSource = (body = "field tag[8] label \"Tag\" use \"compare\" read TAG from tag all @south") => `version 1\ndiagram "table" { mode microarchitecture t: table "Tags" (entries=8) { ${body} } }`;
function skinCell(skin,id){const start=skin.indexOf(`<g s:type="cdiag_${id}"`);if(start<0)return null;const tags=/<g\b[^>]*>|<\/g>/g;tags.lastIndex=start;let depth=0,m;while((m=tags.exec(skin))){if(m[0].startsWith("<g")&&!m[0].endsWith("/>"))depth++;else if(m[0]==="</g>")depth--;if(depth===0)return skin.slice(start,tags.lastIndex);}return null;}

test("CDL starts with a diagram or an explicit version 1 declaration", () => {
  const source = '// Diagram with no version header\ndiagram "Optional version" { input a[1] output y[1] a -> y }';
  assert.deepEqual(compileSource(source).netlist, compileSource("version 1\n" + source).netlist);
  assert.throws(() => parse("version 2\n" + source), { code: "E002" });
  assert.throws(() => parse("version\n" + source), { code: "E001" });
});

test("mode defaults, declarations, and API override", () => {
  assert.equal(parse('version 1 diagram "x" { input mode[1] output y[1] mode -> y }').mode, "circuit");
  assert.equal(parse('version 1 diagram "x" { mode microarchitecture }').mode, "microarchitecture");
  assert.equal(parse('version 1 diagram "x" { mode circuit }', { mode: "microarchitecture" }).mode, "microarchitecture");
  assert.throws(() => parse('version 1 diagram "x" { mode circuit mode microarchitecture }'), /duplicate mode/);
  assert.throws(() => parse('version 1 diagram "x" { mode invalid }'), /invalid mode/);
  assert.throws(() => parse('version 1 diagram "x" { mode microarchitecture }', { mode: "bogus" }), /invalid mode/);
});

test("structured table derives capacities, widths, field bindings and pins", () => {
  const d = parse(tableSource(`field tag[8] label "Tag" use "compare" read TAGS from tag all @south index SET@west write FILL to tag`));
  const b = d.blocks.t;
  assert.deepEqual([b.structuredTable.entries, b.structuredTable.rows, b.structuredTable.ellipsis], [8, 5, true]);
  assert.equal(b.ports.TAGS.width, 64);
  assert.equal(b.ports.SET.width, 3);
  assert.equal(b.ports.FILL.width, 8);
  assert.deepEqual([b.structuredTable.fields[0].msb, b.structuredTable.fields[0].lsb], [7, 0]);
  assert.equal(b.tableBindings[0].field, "tag");
  const skin = generateSkin(d);
  assert.match(skin, /Tag \[8\]/);
  assert.doesNotMatch(skin, /compare|logical entries|>TAGS<|>SET</);
  assert.match(skin, /s:pid="TAGS"/);
  assert.match(skin, /s:pid="SET"/);
  assert.equal(yosysJson(d).modules.top.cells.t.connections.TAGS.length, 64);
});

test("structured table rejects bad parameters and binding declarations", () => {
  const bad = [
    tableSource("field tag[0]"),
    tableSource("field tag[8] index SET[2]"),
    tableSource("field tag[8] index SET@north"),
    tableSource("field tag[8] read TAG from absent"),
    tableSource("field tag[8] read TAG from tag @east"),
    tableSource("field tag[8] write TAG to tag @south"),
    `version 1 diagram "x" { mode microarchitecture t: table "t" (entries=8, rows=5, selected=3) { field x[1] } }`,
    `version 1 diagram "x" { mode microarchitecture t: table "t" (entries=8, rows=2, ellipsis=on) { field x[1] } }`,
    `version 1 diagram "x" { mode microarchitecture t: table "t" (entries=8, rows=9) { field x[1] } }`,
    `version 1 diagram "x" { mode microarchitecture t: table "t" (entries=100000) { field x[1] read X from x all } }`,
    `version 1 diagram "x" { mode circuit t: table "t" (entries=8) { field x[1] } }`,
  ];
  for (const source of bad) assert.throws(() => parse(source));
});

test("capacity-free table widths come from index wiring and all-entry reads", () => {
  const source = `
    version 1 diagram "Capacity-free" {
      mode microarchitecture
      input address[3]
      output tags[64], valid
      t: table "Tags" {
        field tag[8]
        field v[1]
        index SET
        read TAGS from tag all
        read VALID from v all
      }
      address -> t.SET
      t.TAGS -> tags
      t.VALID -> valid
    }
  `;
  const d=parse(source),table=d.blocks.t;
  assert.equal(table.structuredTable.entries,undefined);
  assert.equal(table.structuredTable.rows,5);
  assert.equal(table.ports.SET.width,3);
  assert.equal(table.ports.VALID.width,8);
  assert.equal(d.ports.valid.width,8);
  assert.equal(parse(source.replace("output tags[64]","output tags").replace("read TAGS","read TAGS[64]")).ports.tags.width,64);
  assert.throws(()=>parse(source.replace("tags[64]","tags[63]")),/multiple of its field width/);
  assert.throws(()=>parse(source.replace("tags[64], valid","tags[64], valid[7]")),/same number of entries|width mismatch/);
  assert.throws(()=>parse(source.replace("output tags[64]","output tags")),/cannot infer width/);
});

test("routing can reorder comparator, gate and MUX inputs without changing connections", async () => {
  for (const kind of ["CMP","AND","OR","MUX"]) {
    const source = `version 1 diagram "Crossed sources" {
      mode microarchitecture
      direction TB
      output value[1]@south
      t: table "Signal positions" {
        field left[1] field right[1]
        read LEFT from left read RIGHT from right
      }
      pick: ${kind}(width=1)
      t.LEFT -> pick.B
      t.RIGHT -> pick.A
      pick.Y -> value
    }`;
    const base=compileSource(source);
    const result=await bundleSource(source);
    const pin=(skin,name)=>Number(skinCell(skin,"pick").match(
      new RegExp(`<g s:x="([\\d.]+)" s:y="[\\d.]+" s:pid="${name}"/>`))[1]);
    assert.ok(pin(base.skin,"A")<pin(base.skin,"B"));
    assert.ok(pin(result.skin,"B")<pin(result.skin,"A"),kind);
    assert.deepEqual(result.netlist,base.netlist,kind);
    assert.equal(await renderSvg(source).then(svg=>pin(svg,"B")),pin(result.skin,"B"));
  }
});

test("record fields expose MSB-first slices and avoid treating decomposition as simulation", () => {
  const d = parse(`version 1 diagram "record" { mode microarchitecture r: record "Address" { field tag[20] use "compare" field set[8] field offset[4] } }`);
  const r = d.blocks.r;
  assert.equal(r.ports.IN.width, 32);
  assert.deepEqual(r.recordFields.map(f => [f.id, f.msb, f.lsb]), [["tag",31,12],["set",11,4],["offset",3,0]]);
  assert.equal(d.wirings.length, 0);
  assert.match(generateSkin(d), /s:pid="IN"/);
  assert.throws(() => parse(`version 1 diagram "x" { mode microarchitecture r: record "R" { field IN[1] } }`));
  assert.throws(() => parse(`version 1 diagram "x" { mode microarchitecture r: record "R" { field x[1] in EXTRA[1] } }`));
  assert.throws(() => parse(`version 1 diagram "x" { r: record "R" { field x[1] } }`), /requires? microarchitecture mode/);
});

test("both modes share built-in ports, netlists, and symbols", () => {
  const source = `version 1 diagram "Shared primitives" {
    input query[8], vector[64], fallback[3]
    output index[3]
    m: MATCH(entries=8, width=8)
    p: PRIORITY(entries=8)
    gate: NOT(width=1)
    choose: MUX(width=3)
    query -> m.QUERY
    vector -> m.DATA
    m.MATCH -> p.MATCH
    p.INDEX -> choose.A
    fallback -> choose.B
    p.VALID -> gate.A
    gate.Y -> choose.S
    choose.Y -> index
  }`;
  const d = parse(source);
  const micro = parse(source, { mode: "microarchitecture" });
  assert.deepEqual(micro.blocks, d.blocks);
  assert.deepEqual(yosysJson(micro, true), yosysJson(d, true));
  const circuitSkin = generateSkin(d), microSkin = generateSkin(micro);
  for (const id of Object.keys(d.blocks)) {
    assert.ok(skinCell(circuitSkin, id));
    assert.equal(skinCell(microSkin, id), skinCell(circuitSkin, id));
  }
  assert.equal(d.blocks.m.ports.DATA.width, 64);
  assert.equal(d.blocks.m.ports.MATCH.width, 8);
  assert.equal(d.blocks.p.ports.INDEX.width, 3);
  assert.equal(d.blocks.p.ports.VALID.width, 1);
  for (const mode of ["circuit", "microarchitecture"]) {
    assert.throws(() => parse(`version 1 diagram "x" { mode ${mode} m: MATCH(entries=100000,width=1) }`), { code: "E204" });
    assert.throws(() => parse(`version 1 diagram "x" { mode ${mode} p: PRIORITY(entries=100000) }`), { code: "E204" });
  }
});

test("field-only structured tables and CLI mode errors", () => {
  const d = parse(`version 1 diagram "x" { mode microarchitecture t: table "Fields" (entries=4) { field value[8] label "Value" } }`);
  assert.equal(Object.keys(d.blocks.t.ports).length, 0);
  assert.match(generateSkin(d), /Value \[8\]/);
  assert.doesNotMatch(generateSkin(d), /logical entries|>Value</);
  const missing = spawnSync(process.execPath, ["dist/cli.js", "check", "examples/microarchitecture_cache.cdl", "--mode"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--mode requires/);
  const override = spawnSync(process.execPath, ["dist/cli.js", "check", "examples/microarchitecture_cache.cdl", "--mode", "microarchitecture"], { encoding: "utf8" });
  assert.equal(override.status, 0, override.stderr);
});

test("unannotated gates, MUXes and boxes turn with the flow, preserving pin order and manual sides", () => {
  const pin=(cell,name)=>{
    const match=cell.match(new RegExp(`<g s:x="([\\d.]+)" s:y="([\\d.]+)" s:pid="${name}"/>`));
    assert.ok(match, `missing pin ${name}`);
    return match.slice(1).map(Number);
  };
  const cases=[["LR",0,0,1],["TB",1,0,1],["RL",0,1,0],["BT",1,1,0]];
  for(const [direction,axis,inputEdge,outputEdge] of cases){
    const src=`version 1 diagram "Flow" {
      gate: AND(width=1)
      mux: MUX(width=1)
      box: box "Generic" { in A, B out Y }
      manual: AND(width=1) { in A@west }
      manual_box: box "Manual" { in A@west out Y }
      direction ${direction}
    }`;
    const skin=generateSkin(parse(src));
    for(const id of ["gate","mux","box"]){
      const cell=skinCell(skin,id);
      assert.ok(cell);
      const dimensions=[Number(cell.match(/s:width="(\d+)"/)[1]),Number(cell.match(/s:height="(\d+)"/)[1])];
      const a=pin(cell,"A"), b=pin(cell,"B"), y=pin(cell,"Y");
      assert.equal(a[axis],inputEdge*dimensions[axis],`${direction} ${id} input side`);
      assert.equal(y[axis],outputEdge*dimensions[axis],`${direction} ${id} output side`);
      assert.ok(a[1-axis]<b[1-axis],`${direction} ${id} input order`);
      const arrow=cell.match(/class="port-arrow" data-port="A" d="M ([\d.]+),([\d.]+)/).slice(1).map(Number);
      assert.equal(Math.sign(arrow[axis]-a[axis]),inputEdge?-1:1,`${direction} ${id} arrow points inward`);
    }
    const manual=skinCell(skin,"manual");
    assert.equal(pin(manual,"A")[0],0);
    assert.doesNotMatch(manual,/transform="matrix/);
    const manualBox=skinCell(skin,"manual_box");
    assert.equal(pin(manualBox,"A")[0],0);
    assert.doesNotMatch(manualBox,/transform="matrix/);
  }
});

test("vertical MUX uses the same outline and select anchors in both modes", () => {
  for (const side of ["west", "east", "north", "south"]) {
    const src = `version 1 diagram "mux" { m: MUX(width=8) { in A[8]@north, B[8]@north, S[1]@${side} out Y[8]@south } }`;
    const skin = generateSkin(parse(src));
    const cell = skinCell(skin,"m");
    assert.ok(cell, `missing MUX cell for ${side}`);
    assert.equal(skinCell(generateSkin(parse(src, { mode: "microarchitecture" })), "m"), cell);
    const pin = cell.match(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="S"\/>/);
    assert.ok(pin, `missing select pin for ${side}`);
    const [x,y]=pin.slice(1).map(Number),w=Number(cell.match(/s:width="(\d+)"/)?.[1]),h=Number(cell.match(/s:height="(\d+)"/)?.[1]);
    if(side==="west") assert.deepEqual([x,y],[15,h/2]);
    if(side==="east") assert.deepEqual([x,y],[w-15,h/2]);
    if(side==="north") assert.deepEqual([x,y],[w/2,0]);
    if(side==="south"){
      assert.equal(y,h);
      assert.ok(x<Number(cell.match(/<g s:x="([\d.]+)" s:y="[\d.]+" s:pid="Y"\/>/)[1]));
    }
    assert.match(cell,new RegExp(`M 0,0 L ${w},0 L ${w-30},30 L 30,30 Z`));
    const arrow=cell.match(/class="port-arrow" data-port="S" d="M ([\d.]+),([\d.]+)/);
    const [ax,ay]=arrow.slice(1).map(Number);
    assert.deepEqual([Math.sign(ax-x),Math.sign(ay-y)],{west:[1,0],east:[-1,0],north:[0,1],south:[0,-1]}[side]);
  }
});

test("a wider MUX keeps its taper and shows incoming and outgoing pin arrows", async () => {
  const source=await readFile(new URL("../examples/mux_symbols.cdl",import.meta.url),"utf8");
  const diagram=parse(source);
  assert.deepEqual(Object.keys(diagram.blocks.pick.ports),["A","B","C","D","S","Y"]);
  assert.equal(diagram.blocks.pick.ports.S.width,2);
  assert.throws(()=>parse(source.replace("inputs=4","inputs=17")),/between 2 and 16/);
  const skin=generateSkin(diagram),cell=skinCell(skin,"pick");
  assert.equal(skinCell(generateSkin(parse(source,{mode:"microarchitecture"})),"pick"),cell);
  const slim=skinCell(generateSkin(parse(`version 1 diagram "d" { pick: MUX(width=8) }`)),"pick");
  const taper=/M 0,0 L 30,30 L 30,([\d.]+) L 0,(\d+) Z/;
  for(const symbol of [cell,slim]){
    const outline=symbol.match(taper);
    assert.ok(outline);
    assert.equal(Number(outline[2])-Number(outline[1]),30);
  }
  assert.ok(Number(cell.match(taper)[2])>Number(slim.match(taper)[2]));
  const svg=await renderSvg(source);
  const rendered=skinCell(svg,"pick");
  assert.ok(rendered);
  const arrows=[...rendered.matchAll(/class="port-arrow" data-port="([AY])" d="M ([\d.]+),([\d.]+) L ([\d.]+),[\d.]+/g)];
  assert.equal(arrows.length,2);
  const pins=Object.fromEntries([...cell.matchAll(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="([AY])"\/>/g)].map(([,x,y,name])=>[name,[Number(x),Number(y)]]));
  for(const [,name,tx,ty,bx] of arrows){
    assert.equal(Number(ty),pins[name][1]);
    assert.ok(Number(tx)>Number(bx));
    assert.equal(name==="A"?Number(bx):Number(tx),pins[name][0]);
  }
});

test("record fields stay inside a framed bus strip with boundary pins", () => {
  const skin=generateSkin(parse(`version 1 diagram "record" { mode microarchitecture r: record "Address" { field tag[20] use "match" field set[8] field off[4] } }`));
  const cell=skinCell(skin,"r");assert.ok(cell);
  const height=Number(cell.match(/s:height="(\d+)"/)?.[1]);
  assert.match(cell,new RegExp(`<rect x="0" y="0" width="\\d+" height="${height}"`));
  const inPin=cell.match(/<g s:x="[\d.]+" s:y="([\d.]+)" s:pid="IN"\/>/);assert.equal(Number(inPin[1]),0);
  for(const id of ["tag","set","off"])assert.match(cell,new RegExp(`<g s:x="[\\d.]+" s:y="${height}" s:pid="${id}"`));
  assert.match(cell,/\[31:12\]/);assert.match(cell,/\[11:4\]/);assert.match(cell,/match/);
});

test("structured table decoders terminate at triangle apexes and field ports use top/bottom edges", () => {
  const source=`version 1 diagram "d" { mode microarchitecture t: table "Decode" (entries=16,rows=4) { field low[2] label "Low" field high[4] label "High" index SLOT[4]@west index PAGE[4]@east read R0 from high read R1 from high write W0 to low } }`;
  const d=parse(source),skin=generateSkin(d),cell=skinCell(skin,"t");assert.ok(cell);
  const apexes=[...cell.matchAll(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="(SLOT|PAGE)"\/>/g)];assert.equal(apexes.length,2);
  const triangles=[...cell.matchAll(/<path d="M ([\d.]+),([\d.]+) L ([\d.]+),([\d.]+) L ([\d.]+),([\d.]+) Z"/g)];assert.equal(triangles.length,2);
  for(const m of apexes){const p=triangles.find(t=>Math.abs(Number(t[3])-Number(m[1]))<.01&&Math.abs(Number(t[4])-Number(m[2]))<.01);assert.ok(p,`pin ${m[3]} is not on a decoder apex`);}
  const frame=cell.match(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/);
  assert.ok(frame);
  const top=Number(frame[1]),bottom=top+Number(frame[2]);
  const ports=[...cell.matchAll(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="(R0|R1|W0)"\/>/g)];
  assert.equal(ports.length,3);assert.notEqual(ports[0][1],ports[1][1]);
  assert.equal(Number(ports.find(x=>x[3]==="W0")[2]),top);
  assert.equal(Number(ports.find(x=>x[3]==="R0")[2]),bottom);
  assert.equal(Number(ports.find(x=>x[3]==="R1")[2]),bottom);
  assert.doesNotMatch(cell, />(?:SLOT|PAGE|R0|R1|W0|16 logical entries)</);
});

test("untitled tables do not display metadata and keep control connections separate", () => {
  const source=`version 1 diagram "d" { mode microarchitecture t: table (entries=4) {
    field tag[4] use "Compare with the request tag" index ADDR
    write FILL to tag in CLEAR[1]@north, RESET[1]@north, ENABLE[1]@west
  } }`;
  const cell=skinCell(generateSkin(parse(source)),"t");
  assert.ok(cell);
  assert.deepEqual([...cell.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match=>match[1]),["tag [4]"]);
  const pins=Object.fromEntries([...cell.matchAll(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="(\w+)"\/>/g)].map(([,x,y,id])=>[id,[Number(x),Number(y)]]));
  assert.equal(new Set([pins.FILL[0],pins.CLEAR[0],pins.RESET[0]]).size,3);
  assert.ok(pins.ENABLE[0]>pins.ADDR[0]&&pins.ENABLE[1]<pins.ADDR[1]);
});

test("a 2R1W table binds independent indices to distinct read and write pins", async () => {
  const source=await readFile(new URL("../examples/microarchitecture_2r1w.cdl",import.meta.url),"utf8");
  const diagram=parse(source),block=diagram.blocks.regs;
  assert.deepEqual(block.tableBindings.map(({port,index})=>[port,index]),[["RD_A","RA"],["RD_B","RB"],["WD","WA"]]);
  assert.throws(()=>parse(source.replace("via RA","via UNKNOWN")),/unknown table index UNKNOWN/);
  assert.throws(()=>parse(source.replace("from value via RA","from value all via RA")),/all-entry reads cannot select/);
  const cell=skinCell(await renderSvg(source),"regs");
  assert.ok(cell);
  const frame=cell.match(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="([\d.]+)"/);
  const [left,width,height]=frame.slice(1).map(Number);
  const pins=Object.fromEntries([...cell.matchAll(/<g s:x="([\d.]+)" s:y="([\d.]+)" s:pid="(\w+)"\/>/g)]
    .map(([,x,y,id])=>[id,[Number(x),Number(y)]]));
  assert.ok(pins.RA[0]<left&&pins.RB[0]<left&&pins.RA[1]!==pins.RB[1]);
  assert.ok(pins.WA[0]>left+width);
  assert.equal(pins.WD[1],0);
  assert.equal(pins.RD_A[1],height);
  assert.equal(pins.RD_B[1],height);
  assert.notEqual(pins.RD_A[0],pins.RD_B[0]);
  assert.deepEqual([...cell.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match=>match[1]),["Register file","Value [32]"]);
});

test("legacy box tables stay separate from structured table mode", async () => {
  const src = await readFile(new URL("../examples/set_associative_cache.cdl", import.meta.url), "utf8");
  const d = parse(src);
  assert.ok(Object.values(d.blocks).some(b => b.table));
  assert.equal(Object.values(d.blocks).some(b => b.structuredTable), false);
  assert.equal(d.mode, "circuit");
});

for (const name of ["cache", "tage", "reservation_station", "mmu"]) {
  test(`Netlist2SVG renders microarchitecture ${name} example`, async () => {
    const src = await readFile(new URL(`../examples/microarchitecture_${name}.cdl`, import.meta.url), "utf8");
    const diagram=parse(src);for(const [pn,p] of Object.entries(diagram.ports)){const used=diagram.wirings.some(w=>(p.direction==="input"?w.sources:w.sinks).some(r=>r.endpoint===pn));assert.ok(used,`${name} top-level port ${pn} is disconnected`);}
    const svg = await renderSvg(src);
    assert.match(svg, /<svg/);
    assert.match(svg, /<path|<rect/);
  });
}
