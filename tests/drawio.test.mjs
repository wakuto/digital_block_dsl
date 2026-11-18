import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { renderDrawioSvg, renderSvg } from "../dist/node.js";

const {parse}=createRequire(import.meta.url)("onml");
const elements=(node,name)=>node.slice(2).filter(child=>Array.isArray(child)&&child[0]===name);
function model(svg) {
  const file=parse(parse(svg)[1].content);
  assert.equal(file[0],"mxfile");
  const [diagram]=elements(file,"diagram");
  const [graph]=elements(diagram,"mxGraphModel");
  const [root]=elements(graph,"root");
  return {diagram, graph, cells:elements(root,"mxCell")};
}
function stencil(cell) {
  const encoded=cell[1].style.match(/shape=stencil\(([^)]+)\)/)[1];
  return parse(decodeURIComponent(inflateRawSync(Buffer.from(encoded,"base64")).toString()));
}
const constraints=cell=>elements(elements(stencil(cell),"connections")[0],"constraint").map(pin=>pin[1]);
const tablePoints=cell=>JSON.parse(cell[1].style.match(/points=([^;]+);/)[1]);
const byId=cells=>new Map(cells.map(cell=>[cell[1].id,cell]));

test("editable SVG preserves its preview and embeds connected native cells", async () => {
  const source=await readFile(new URL("../examples/microarchitecture_2r1w.cdl",import.meta.url),"utf8");
  const svg=await renderDrawioSvg(source);
  assert.equal(svg.replace(/ content="[^"]*"/,""),await renderSvg(source));
  const {cells}=model(svg);
  const table=cells.find(cell=>cell[1].value==="Register file");
  assert.match(table[1].style,/shape=table;childLayout=tableLayout;/);
  const rows=cells.filter(cell=>cell[1].parent===table[1].id);
  assert.ok(rows.length>1);
  for(const row of rows){
    assert.match(row[1].style,/shape=tableRow;/);
    const cell=cells.find(cell=>cell[1].parent===row[1].id);
    const [[,bounds]]=elements(cell,"mxGeometry");
    assert.equal(Number(bounds.width)%10,0);
    assert.equal(bounds.height,"30");
  }
  assert.deepEqual(tablePoints(table).map(point=>point[1]),[0,1,1]);
  const decoders=cells.filter(cell=>cell[1].parent===table[1].parent&&cell[1].id.includes("_p_"));
  assert.deepEqual(decoders.map(cell=>constraints(cell)[0].name).sort(),["RA","RB","WA"]);
  const edges=cells.filter(cell=>cell[1].edge==="1");
  assert.equal(edges.length,6);
  for(const edge of edges){
    assert.ok(cells.some(cell=>cell[1].id===edge[1].source&&cell[1].vertex==="1"));
    assert.ok(cells.some(cell=>cell[1].id===edge[1].target&&cell[1].vertex==="1"));
    assert.match(edge[1].style,/exitPerimeter=0;.*entryPerimeter=0;/);
  }
  assert.ok(edges.some(e=>elements(elements(e,"mxGeometry")[0],"Array").length));
  assert.ok(!cells.some(c=>c[1].style?.includes("shape=image")));
});

test("a legacy table keeps its header, body, and ellipsis cells at the same height", async () => {
  const source=`version 1 diagram "Rows" {
    memory: box "Memory" {
      table(columns="Tag|Data", rows=5, ellipsis=on, indices="0|1|2||n−1")
      in ADDR[1]
      out VALUE[1]
    }
  }`;
  const {cells}=model(await renderDrawioSvg(source));
  const table=cells.find(cell=>cell[1].value==="Memory");
  const rows=cells.filter(cell=>cell[1].parent===table[1].id);
  assert.equal(rows.length,5);
  for(const row of rows){
    const columns=cells.filter(cell=>cell[1].parent===row[1].id);
    assert.equal(columns.length,2);
    for(const column of columns) assert.equal(elements(column,"mxGeometry")[0][1].height,"30");
  }
});

test("draw.io model preserves literal labels and turned gate geometry", async () => {
  const source=`version 1 diagram "Logic & timing" {
    direction TB
    input a[1], b[1]
    output y[1]
    gate: AND(width=1) { label "A & B <gate>" }
    a -> gate.A
    b -> gate.B
    gate.Y -> y
  }`;
  const {diagram,cells}=model(await renderDrawioSvg(source));
  assert.equal(diagram[1].name,"Logic & timing");
  for(const name of ["a","b","y"])assert.ok(cells.some(cell=>cell[1].value===name),name);
  const text=cells.find(cell=>cell[1].value==="A & B <gate>");
  assert.match(text[1].style,/html=0/);
  const gate=cells.find(cell=>cell[1].id===text[1].parent);
  const shape=stencil(gate);
  const paths=elements(elements(shape,"foreground")[0],"path");
  const [tip]=elements(paths[0],"curve");
  assert.equal(Number(tip[1].x3),Number(shape[1].w)/2);
  assert.equal(tip[1].y3,shape[1].h);
  const [[,{x,y,width,height}]]=elements(gate,"mxGeometry");
  assert.deepEqual([Number(width),Number(height)],[60,80]);
  const pins=constraints(gate);
  const portPoint=pin=>[Math.round(Number(pin.x)*width),Math.round(Number(pin.y)*height)];
  assert.deepEqual(pins.filter(pin=>pin.name!=="Y").map(portPoint).sort(),[[20,0],[40,0]]);
  assert.deepEqual(portPoint(pins.find(pin=>pin.name==="Y")),[30,80]);
  for(const pin of pins){
    const [px,py]=portPoint(pin);
    assert.ok(Math.abs(Number(x)+Number(pin.x)*width-(Number(x)+px))<1e-9);
    assert.ok(Math.abs(Number(y)+Number(pin.y)*height-(Number(y)+py))<1e-9);
    assert.equal((Number(x)+px)%10,0);
    assert.equal((Number(y)+py)%10,0);
    const incoming=pin.name!=="Y", end=incoming?"entry":"exit", side=incoming?"target":"source";
    assert.ok(cells.some(cell=>cell[1][side]===gate[1].id&&
      cell[1].style.includes(`${end}X=${pin.x};${end}Y=${pin.y};`)));
  }
  const inputMarks=paths.slice(1,3).map(arrow=>{
    const [a,b]=elements(arrow,"line").map(line=>line[1]);
    return [(Number(a.x)+Number(b.x))/2,(Number(a.y)+Number(b.y))/2];
  }).sort();
  assert.deepEqual(inputMarks,[[20,0],[40,0]]);
});

test("every drawn port is a fixed connection point, including unused and reordered pins", async () => {
  const source=`version 1 diagram "Connection points" {
    mode microarchitecture
    direction TB
    input idle[1]@west
    output value[1]@south
    t: table "Signals" {
      field left[1] field right[1]
      index WA@east
      read LEFT from left read RIGHT from right
      write WD to left via WA
    }
    pick: MUX(width=1)
    unused: AND(width=1)
    t.LEFT -> pick.B
    t.RIGHT -> pick.A
    pick.Y -> value
  }`;
  const svg=await renderDrawioSvg(source);
  const {cells}=model(svg);
  const vertices=byId(cells);
  const symbols=elements(parse(svg),"g").filter(group=>group[1].id?.startsWith("cell_"));
  const pinsBySymbol=new Map();
  for(const [i,symbol] of symbols.entries()){
    const cell=vertices.get("v"+i);
    if(cell[1].style.startsWith("shape=table;"))continue;
    const [,stencilSize]=stencil(cell);
    const [[,bounds]]=elements(cell,"mxGeometry");
    const pins=constraints(cell);
    const drawnPins=elements(symbol,"g").filter(group=>group[1]["s:pid"]);
    assert.deepEqual(pins.map(pin=>pin.name).sort(),drawnPins.map(group=>group[1]["s:pid"]).sort());
    const byName=new Map(pins.map(pin=>[pin.name,pin]));
    for(const [,attrs] of drawnPins){
      const pin=byName.get(attrs["s:pid"]);
      assert.equal(pin.perimeter,"0");
      const x=Number(pin.x)*Number(bounds.width);
      const y=Number(pin.y)*Number(bounds.height);
      assert.ok(Math.abs(x-Math.round(x))<1e-9);
      assert.ok(Math.abs(y-Math.round(y))<1e-9);
      assert.ok(Math.abs(x-Number(attrs["s:x"])*bounds.width/stencilSize.w)<=0.5001);
      assert.ok(Math.abs(y-Number(attrs["s:y"])*bounds.height/stencilSize.h)<=0.5001);
    }
    pinsBySymbol.set(symbol[1].id,{id:cell[1].id,pins:byName});
  }
  const pick=pinsBySymbol.get("cell_pick");
  assert.deepEqual([...pick.pins.keys()].sort(),["A","B","S","Y"]);
  assert.ok(Number(pick.pins.get("B").x)<Number(pick.pins.get("A").x));
  assert.deepEqual([...pinsBySymbol.get("cell_unused").pins.keys()].sort(),["A","B","Y"]);
  assert.ok(pinsBySymbol.get("cell_idle").pins.has("Y"));
  const table=cells.find(cell=>cell[1].value==="Signals");
  assert.deepEqual(tablePoints(table).map(point=>point[1]).sort(),[0,1,1]);
  assert.deepEqual(constraints(vertices.get(table[1].id+"_p_WA")).map(pin=>pin.name),["WA"]);
  const entries=cells.filter(cell=>cell[1].target===pick.id).map(cell=>cell[1].style);
  for(const name of ["A","B"]){
    const {x,y}=pick.pins.get(name);
    assert.ok(entries.some(style=>style.includes(`entryX=${x};entryY=${y};entryPerimeter=0;`)));
  }
});

test("draw.io aligns symbols to a 10 pt grid and reconnects orthogonal wires", async () => {
  const source=await readFile(new URL("../examples/microarchitecture_mmu.cdl",import.meta.url),"utf8");
  const svg=await renderDrawioSvg(source);
  const {graph,cells}=model(svg);
  assert.equal(graph[1].grid,"1");
  assert.equal(graph[1].gridSize,"10");
  const vertices=byId(cells);
  const symbols=elements(parse(svg),"g").filter(group=>group[1].id?.startsWith("cell_"));
  const geometryById=new Map();
  const coords=node=>({x:Number(node[1].x),y:Number(node[1].y)});
  function snapEndpoint(edge,style,which,geometry) {
    const terminal=geometryById.get(edge[1][which==="exit"?"source":"target"]);
    if(!terminal){
      const role=which==="exit"?"sourcePoint":"targetPoint";
      return coords(elements(geometry,"mxPoint").find(p=>p[1].as===role));
    }
    return {
      x:terminal.x+Number(style.get(which+"X"))*terminal.width,
      y:terminal.y+Number(style.get(which+"Y"))*terminal.height,
    };
  }
  for(const [i,symbol] of symbols.entries()){
    const vertex=vertices.get("v"+i);
    const [geometry]=elements(vertex,"mxGeometry");
    let {x,y}=coords(geometry);
    if(vertex[1].parent!=="1"){
      const parent=coords(elements(vertices.get(vertex[1].parent),"mxGeometry")[0]);
      x+=parent.x;
      y+=parent.y;
    }
    const {width,height}=geometry[1];
    assert.equal(x%10,0);
    assert.equal(y%10,0);
    assert.equal(Number(width)%10,0);
    if(symbol[1].id.startsWith("cell_$bus$")){
      assert.equal(height,"25");
    }else{
      assert.equal(Number(height)%10,0);
    }
    geometryById.set(vertex[1].id,{x,y,width:Number(width),height:Number(height)});
  }
  for(const vertex of cells.filter(cell=>cell[1].id.includes("_p_"))){
    const [geometry]=elements(vertex,"mxGeometry");
    const {x,y}=coords(geometry);
    const parent=coords(elements(vertices.get(vertex[1].parent),"mxGeometry")[0]);
    geometryById.set(vertex[1].id,{x:x+parent.x,y:y+parent.y,
      width:Number(geometry[1].width),height:Number(geometry[1].height)});
  }
  const edges=cells.filter(cell=>cell[1].edge==="1");
  const junctions=cells.filter(cell=>/^j\d+$/.test(cell[1].id));
  assert.ok(junctions.length);
  assert.ok(edges.some(([,edge])=>/^j\d+$/.test(edge.source)&&/^j\d+$/.test(edge.target)));
  for(const junction of junctions){
    const [geometry]=elements(junction,"mxGeometry");
    const {id,connectable,style}=junction[1];
    assert.equal(connectable,"1");
    assert.match(style,/points=\[\[0\.5,0\.5,0\]\]/);
    const incoming=edges.filter(cell=>cell[1].target===id);
    const outgoing=edges.filter(cell=>cell[1].source===id);
    assert.equal(incoming.length,1);
    assert.ok(outgoing.length>=2);
    assert.match(incoming[0][1].style,/entryX=0\.5;entryY=0\.5;entryPerimeter=0;/);
    assert.ok(outgoing.every(cell=>/exitX=0\.5;exitY=0\.5;exitPerimeter=0;/.test(cell[1].style)));
    geometryById.set(id,{...coords(geometry),width:Number(geometry[1].width),height:Number(geometry[1].height)});
  }
  let gridRuns=0;
  for(const edge of edges){
    const style=new Map(edge[1].style.split(";").map(field=>field.split("=")));
    const [geometry]=elements(edge,"mxGeometry");
    const [waypoints]=elements(geometry,"Array");
    const route=[snapEndpoint(edge,style,"exit",geometry),
      ...(waypoints?elements(waypoints,"mxPoint").map(coords):[]),
      snapEndpoint(edge,style,"entry",geometry)];
    for(const [i,point] of route.slice(1).entries()){
      assert.ok(Math.abs(point.x-route[i].x)<0.0001||Math.abs(point.y-route[i].y)<0.0001,edge[1].id);
      if((point.x===route[i].x&&point.x%10===0)||(point.y===route[i].y&&point.y%10===0))gridRuns++;
    }
  }
  assert.ok(gridRuns>20);
});

test("cache fanout shows one width per signal and has editable record fields", async () => {
  const source=await readFile(new URL("../examples/microarchitecture_cache.cdl",import.meta.url),"utf8");
  const svg=await renderDrawioSvg(source);
  const {cells}=model(svg);
  const address=cells.find(cell=>cell[1].value==="Address");
  assert.match(address[1].style,/shape=table;childLayout=tableLayout;/);
  const row=cells.find(cell=>cell[1].parent===address[1].id);
  const fields=cells.filter(cell=>cell[1].parent===row[1].id);
  assert.deepEqual(fields.map(cell=>cell[1].value),["Tag [23]\n[31:9]","Set [6]\n[8:3]","Byte offset [3]\n[2:0]"]);
  const edges=cells.filter(cell=>cell[1].edge==="1");
  const fromAddress=edges.filter(edge=>edge[1].source===address[1].id);
  const comparators=cells.filter(cell=>cell[1].value==="=").map(cell=>cell[1].parent);
  assert.equal(comparators.length,2);
  const tagTrunk=fromAddress.find(edge=>{
    const branches=edges.filter(branch=>branch[1].source===edge[1].target);
    return branches.length===2&&comparators.every(id=>branches.some(branch=>branch[1].target===id));
  });
  assert.ok(tagTrunk,"the address tag reaches both comparators through a common trunk");
  assert.match(tagTrunk[1].target,/^j\d+$/);
  const outputPin=tagTrunk[1].style.match(/exitX=[^;]+;exitY=[^;]+;/)[0];
  assert.equal(fromAddress.filter(edge=>edge[1].style.includes(outputPin)).length,1);
  const tagNet=[tagTrunk,...edges.filter(edge=>edge[1].source===tagTrunk[1].target)];
  assert.equal(tagNet.filter(edge=>edge[1].value==="/23/").length,1);
  assert.equal(edges.filter(edge=>edge[1].value==="/23/").length,3);
  const root=parse(svg);
  assert.equal(elements(root,"text").filter(node=>node[2]==="/23/").length,3);
  for(const symbol of elements(root,"g").filter(node=>/^cell_(match0|match1|choose)$/.test(node[1].id))){
    assert.ok(!elements(symbol,"text").some(node=>/^(A|B|S|Y)$/.test(node[2])));
  }
});
