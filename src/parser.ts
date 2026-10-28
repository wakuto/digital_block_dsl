import { DiagramError, signalToString, type Block, type Diagram, type Direction, type Net, type Port, type SignalRef, type Wiring } from "./model.js";
import { validatePreset } from "./symbols.js";

interface Tok { value: string; kind: "word" | "int" | "string" | "punct"; line: number; column: number }
function lex(source: string): Tok[] {
  const out: Tok[] = []; let i = 0, line = 1, column = 1;
  const advance = (s: string) => { for (const c of s) { if (c === "\n") { line++; column = 1; } else column++; } i += s.length; };
  while (i < source.length) {
    const rest = source.slice(i), ws = /^(\s+)/.exec(rest);
    if (ws) { advance(ws[0]); continue; }
    const comment = /^\/\/[^\r\n]*/.exec(rest); if (comment) { advance(comment[0]); continue; }
    const start = { line, column };
    const str = /^"(?:\\.|[^"\\])*"/.exec(rest);
    if (str) { out.push({ ...start, kind: "string", value: str[0] }); advance(str[0]); continue; }
    const arrow = /^->/.exec(rest); if (arrow) { out.push({ ...start, kind: "punct", value: "->" }); advance("->"); continue; }
    const num = /^\d+/.exec(rest); if (num) { out.push({ ...start, kind: "int", value: num[0] }); advance(num[0]); continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest); if (word) { out.push({ ...start, kind: "word", value: word[0] }); advance(word[0]); continue; }
    if ("{}():,=[]@.".includes(source[i])) { out.push({ ...start, kind: "punct", value: source[i] }); advance(source[i]); continue; }
    throw new DiagramError("E001", `syntax error: unexpected character ${JSON.stringify(source[i])}`, line, column);
  }
  out.push({ value: "<eof>", kind: "punct", line, column }); return out;
}

class Reader {
  readonly ts: Tok[]; pos = 0;
  constructor(source: string) { this.ts = lex(source); }
  get t(): Tok { return this.ts[this.pos]; }
  pop(): Tok { return this.ts[this.pos++]; }
  is(v: string): boolean { return this.t.value === v; }
  take(v: string): boolean { if (!this.is(v)) return false; this.pop(); return true; }
  need(v: string): Tok { if (!this.is(v)) this.fail(`expected ${JSON.stringify(v)}`); return this.pop(); }
  fail(message: string): never { throw new DiagramError("E001", `syntax error: ${message}`, this.t.line, this.t.column); }
  word(): Tok { if (this.t.kind !== "word") this.fail("expected identifier"); return this.pop(); }
  integer(): number { if (this.t.kind !== "int") this.fail("expected integer"); return Number(this.pop().value); }
  string(): string { if (this.t.kind !== "string") this.fail("expected string"); try { return JSON.parse(this.pop().value); } catch { return this.fail("invalid string"); } }
  ref(): SignalRef {
    const start = this.t, parts = [this.word().value]; if (this.take(".")) parts.push(this.word().value);
    const endpoint = parts.join("."); if (!this.take("[")) return { endpoint, msb: null, lsb: null };
    const hi = this.integer(); let lo = hi; if (this.take(":")) lo = this.integer(); this.need("]");
    if (hi < lo) throw new DiagramError("E206", `reversed bit selection ${endpoint}[${hi}:${lo}]; use [msb:lsb]`, start.line);
    return { endpoint, msb: hi, lsb: lo };
  }
  endpoint(): string { return this.ref().endpoint; }
  ports(direction: Direction): Record<string, Port> {
    const result: Record<string, Port> = {};
    do {
      const tok = this.word(), p: Port = { name: tok.value, direction, width: null, side: null, line: tok.line };
      if (this.take("[")) { p.width = this.integer(); this.need("]"); if (p.width === 0) throw new DiagramError("E201", `port ${p.name} width must be positive`, tok.line); }
      if (this.take("@")) { const side = this.word().value; if (!["west", "east", "north", "south"].includes(side)) this.fail("invalid port side"); p.side = side as Port["side"]; }
      if (result[p.name]) throw new DiagramError("E102", `duplicate port ${JSON.stringify(p.name)}`, p.line);
      result[p.name] = p;
    } while (this.take(","));
    return result;
  }
  params(): Record<string, string | number> {
    const result: Record<string, string | number> = {}; this.need("(");
    if (!this.take(")")) { do { const key = this.word(); this.need("="); let val: string | number;
      if (this.t.kind === "int") val = this.integer(); else if (this.t.kind === "string") val = this.string(); else val = this.word().value;
      if (key.value in result) throw new DiagramError("E102", `duplicate parameter ${JSON.stringify(key.value)}`, key.line); result[key.value] = val;
    } while (this.take(",")); this.need(")"); }
    return result;
  }
  signalExpr(): SignalRef[] {
    if (!this.take("{")) return [this.ref()];
    const refs = [this.ref()]; this.need(","); refs.push(this.ref()); while (this.take(",")) refs.push(this.ref()); this.need("}"); return refs;
  }
}

function getPort(d: Diagram, ep: string, line: number): Port {
  const parts = ep.split(".");
  if (parts.length === 1) { const p = d.ports[ep]; if (!p) throw new DiagramError("E101", `unknown diagram port ${JSON.stringify(ep)}`, line); return p; }
  const b = d.blocks[parts[0]]; if (!b) throw new DiagramError("E101", `unknown block ${JSON.stringify(parts[0])}`, line);
  const p = b.ports[parts[1]]; if (!p) throw new DiagramError("E101", `unknown port ${JSON.stringify(ep)}; available: ${Object.keys(b.ports).join(", ")}`, line); return p;
}
function role(d: Diagram, ep: string, line: number): "source" | "sink" { const p = getPort(d, ep, line); return ep.includes(".") ? p.direction === "output" ? "source" : "sink" : p.direction === "input" ? "source" : "sink"; }
function refWidth(d: Diagram, r: SignalRef, line: number): number | null {
  const p = getPort(d, r.endpoint, line); if (r.msb === null) return p.width;
  if (p.width === null) throw new DiagramError("E207", `slice ${signalToString(r)} requires an explicitly sized port`, line);
  if (r.msb >= p.width) throw new DiagramError("E206", `slice ${signalToString(r)} is outside ${p.width}-bit port`, line);
  return r.msb - r.lsb! + 1;
}
function setRefWidth(d: Diagram, r: SignalRef, width: number, line: number): boolean {
  if (width < 1) throw new DiagramError("E204", `invalid inferred width ${width} for ${signalToString(r)}`, line);
  if (r.msb !== null) { if (refWidth(d, r, line) !== width) throw new DiagramError("E204", `width mismatch on selected port ${signalToString(r)}`, line); return false; }
  const p = getPort(d, r.endpoint, line); if (p.width !== null && p.width !== width) throw new DiagramError("E204", `width mismatch: ${signalToString(r)} has ${p.width} bits, expected ${width}`, line);
  if (p.width === null) { p.width = width; return true; } return false;
}
function resolve(d: Diagram): void {
  for (const w of d.wirings) {
    for (const r of w.sources) if (role(d, r.endpoint, w.line) !== "source") throw new DiagramError("E103", `${signalToString(r)} cannot drive a net`, w.line);
    for (const r of w.sinks) if (role(d, r.endpoint, w.line) !== "sink") throw new DiagramError("E103", `${signalToString(r)} cannot receive a net`, w.line);
    for (const r of [...w.sources, ...w.sinks]) if (r.msb !== null && getPort(d, r.endpoint, w.line).width === null) throw new DiagramError("E207", `slice ${signalToString(r)} requires an explicitly sized port`, w.line);
  }
  for (let pass = 0; pass < Math.max(2, d.wirings.length * 3 + 1); pass++) {
    let changed = false;
    for (const w of d.wirings) {
      const sw = w.sources.map(r => refWidth(d, r, w.line)), dw = w.sinks.map(r => refWidth(d, r, w.line));
      const available = [w.width, ...dw, ...(w.sources.length === 1 ? [sw[0]] : [])].filter((x): x is number => x !== null);
      if (new Set(available).size > 1) throw new DiagramError("E204", `width mismatch in connection at line ${w.line}: ${[...new Set(available)].sort((a,b)=>a-b)}`, w.line);
      let target = available[0] ?? null;
      if (sw.every(x => x !== null)) { const joined = sw.reduce((a,b)=>a!+b!, 0); if (target !== null && joined !== target) throw new DiagramError("E204", `concat/connection width ${joined} does not match ${target}`, w.line); target = joined; }
      if (target === null) continue;
      for (const sink of w.sinks) changed = setRefWidth(d, sink, target, w.line) || changed;
      const missing = sw.map((x,i)=>x === null ? i : -1).filter(i=>i>=0);
      if (missing.length === 1) { const remainder = target - sw.reduce<number>((n,x)=>n+(x??0),0); changed = setRefWidth(d,w.sources[missing[0]],remainder,w.line)||changed; }
    }
    if (!changed) break;
  }
  const owners = new Map<string,string>(), nets: Record<string,Net> = {}, names = new Map<string,string>();
  for (const w of d.wirings) {
    const widths = w.sources.map(r=>refWidth(d,r,w.line));
    if (w.sources.length > 1 && widths.some(x=>x===null)) throw new DiagramError("E207","cannot infer concat component widths; declare widths on source ports",w.line);
    const total = widths.reduce<number>((n,x)=>n+(x??1),0);
    if (w.width !== null && w.width !== total) throw new DiagramError("E204",`named net ${JSON.stringify(w.name)}: expected ${w.width} bits, received ${total}`,w.line);
    w.width = total;
    for (const sink of w.sinks) { const sw=refWidth(d,sink,w.line)??1; if(sw!==total) throw new DiagramError("E204",`width mismatch: ${total}-bit source to ${signalToString(sink)} (${sw} bits)`,w.line); }
    const sourceBits: string[]=[];
    for(let i=w.sources.length-1;i>=0;i--){const r=w.sources[i], width=widths[i]??1, lo=r.lsb??0; for(let bit=lo;bit<lo+width;bit++) sourceBits.push(`${r.endpoint}:${bit}`);}
    for(const sink of w.sinks){const lo=sink.lsb??0; sourceBits.forEach((src,index)=>{const dest=`${sink.endpoint}:${lo+index}`,old=owners.get(dest);if(old&&old!==src)throw new DiagramError("E105",`${signalToString(sink)} bit ${lo+index} has multiple drivers`,w.line);owners.set(dest,src);});}
    if(w.name!==null){const key=sourceBits.join(",");if(names.has(w.name)&&names.get(w.name)!==key)throw new DiagramError("E104",`net name ${JSON.stringify(w.name)} assigned to distinct nets`,w.line);names.set(w.name,key);}
    if(w.sources.length===1&&w.sources[0].msb===null&&w.sinks.every(s=>s.msb===null)){
      const ep=w.sources[0].endpoint; const n=nets[ep]??(nets[ep]={driver:ep,sinks:[],width:w.width,name:w.name,line:w.line});
      if(n.name&&w.name&&n.name!==w.name)throw new DiagramError("E104",`conflicting names on ${ep}`,w.line); if(w.name)n.name=w.name;
      if(n.width!==w.width)throw new DiagramError("E204",`width mismatch on ${ep}`,w.line); for(const s of w.sinks)if(!n.sinks.includes(s.endpoint))n.sinks.push(s.endpoint);
    }
  }
  d.nets=Object.values(nets);
}

/** Parse, validate and infer widths from a v0.4 .cdl source string. */
export function parse(source: string): Diagram {
  const r = new Reader(source); const version = r.word(); if(version.value!=="version")r.fail("expected version declaration"); const v=r.integer(); if(v!==1)throw new DiagramError("E002","only version 1 is supported",version.line);
  const key=r.word();if(key.value!=="diagram")r.fail("expected diagram declaration");const title=r.string();r.need("{");
  const d:Diagram={title,direction:"LR",theme:"light",layout:"balanced",netlabels:true,ports:{},blocks:{},nets:[],wirings:[]};
  while(!r.take("}")){
    if(r.is("<eof>"))r.fail("unterminated diagram");const t=r.t;
    if(r.is("direction")){r.pop();const x=r.word();if(!["LR","RL","TB","BT"].includes(x.value))r.fail("invalid direction");d.direction=x.value as Diagram["direction"];continue;}
    if(r.is("theme")){r.pop();const x=r.word();if(!["light","dark","mono"].includes(x.value))r.fail("invalid theme");d.theme=x.value as Diagram["theme"];continue;}
    if(r.is("layout")){r.pop();const x=r.word();if(!["balanced","compact","feedback"].includes(x.value))r.fail("invalid layout");d.layout=x.value as Diagram["layout"];continue;}
    if(r.is("netlabels")){r.pop();const x=r.word();if(x.value!=="on"&&x.value!=="off")r.fail("invalid netlabels setting");d.netlabels=x.value==="on";continue;}
    if(r.is("input")||r.is("output")){const dir=r.pop().value as Direction, declared=r.ports(dir);for(const [pn,p]of Object.entries(declared)){if(d.ports[pn]||d.blocks[pn])throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(pn)}`,p.line);d.ports[pn]=p;}continue;}
    if(r.is("net")){
      r.pop();const name=r.word();let width:number|null=null;if(r.take("[")){width=r.integer();r.need("]");if(width===0)throw new DiagramError("E201",`net ${name.value} width must be positive`,t.line);}r.need("=");const sources=r.signalExpr();r.need("->");const sinks=[r.ref()];while(r.take(","))sinks.push(r.ref());d.wirings.push({sources,sinks,name:name.value,width,line:t.line});continue;
    }
    if(t.kind!=="word")r.fail("expected declaration");const name=r.word();
    if(r.take(":")){
      if(name.value in d.blocks||name.value in d.ports)throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(name.value)}`,name.line);
      let type:string,label:string,params:Record<string,string|number>={};
      if(r.is("box")){r.pop();type="box";label=r.string();}else{type=r.word().value;label=type;if(r.is("("))params=r.params();}
      const preset=validatePreset(type,params,name.line), ports=preset??{};let style:string|null=null;
      if(r.take("{")){while(!r.take("}")){if(r.is("style")){r.pop();style=r.word().value;if(!["logic","storage","control","neutral","accent"].includes(style))r.fail("invalid style");}
          else if(r.is("label")){r.pop();label=r.string();}
          else if(r.is("in")||r.is("out")){const local=r.pop(), dir:Direction=local.value==="in"?"input":"output", extras=r.ports(dir);for(const [pn,p]of Object.entries(extras)){if(ports[pn]){const old=ports[pn];if(!preset||old.direction!==p.direction||(p.width!==null&&p.width!==old.width))throw new DiagramError("E102",`incompatible duplicate port ${name.value}.${pn}`,p.line);if(p.side)old.side=p.side;}else{if(preset)throw new DiagramError("E102",`cannot add port ${JSON.stringify(pn)} to builtin ${type}`,p.line);ports[pn]=p;}}}
          else r.fail("expected block body declaration");}}
      if(!Object.keys(ports).length)throw new DiagramError("E203",`${name.value} has no ports; declare them using a block body`,name.line);
      d.blocks[name.value]={id:name.value,type,label,ports,params,line:name.line,builtin:preset!==null,style};continue;
    }
    r.pos--;const start=r.t;const sources=r.signalExpr();if(!r.take("->"))r.fail("expected ':' for block declaration or '->' for connection");const sinks=[r.ref()];while(r.take(","))sinks.push(r.ref());d.wirings.push({sources,sinks,name:null,width:null,line:start.line});
  }
  if(!r.is("<eof>"))r.fail("unexpected content after diagram");
  for(const p of Object.values(d.ports))if(d.blocks[p.name])throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(p.name)}`,p.line);
  resolve(d);return d;
}
