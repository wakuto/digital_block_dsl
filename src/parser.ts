import { DiagramError, signalToString, type Block, type Diagram, type Direction, type Net, type Port, type SignalRef, type Wiring, type Table, type StructuredTable, type MicroField, type TableBinding } from "./model.js";
import { parseTable } from "./table.js";
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
  optionalBindingWidth(port: Tok): number | null {
    if (!this.take("[")) return null;
    const width = this.integer(); this.need("]");
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_TABLE_VECTOR)
      throw new DiagramError("E204", "table port width must be 1 through 65536 bits", port.line);
    return width;
  }
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
  /** Parses inline orientation modifiers: `@90`, `@180`, `@270`, `@flipx`, `@flipy`. */
  orientation(o: Pick<Block, "rotation" | "flipX" | "flipY" | "explicitRotation">): void {
    while (this.take("@")) {
      if (this.t.kind === "int") { const deg = this.integer(); if (![0, 90, 180, 270].includes(deg)) this.fail("rotation must be 0, 90, 180 or 270"); o.rotation = deg as Block["rotation"]; o.explicitRotation = true; }
      else { const w = this.word().value; if (w === "flipx") o.flipX = true; else if (w === "flipy") o.flipY = true; else this.fail("expected 90, 180, 270, flipx or flipy"); }
    }
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
const MAX_TABLE_VECTOR = 65536;
function tableVectorGroups(d: Diagram) {
  return Object.values(d.blocks).flatMap(b => {
    if (!b.structuredTable || b.structuredTable.entries !== undefined) return [];
    const fields = new Map(b.structuredTable.fields.map(f => [f.id, f.width]));
    const reads = (b.tableBindings ?? []).filter(binding => binding.all).map(binding => ({
      port: b.ports[binding.port], fieldWidth: fields.get(binding.field)!,
    }));
    return reads.length ? [{ id: b.id, reads }] : [];
  });
}
function resolveTableVectors(groups: ReturnType<typeof tableVectorGroups>, final = false): boolean {
  let changed = false;
  for (const { id, reads } of groups) {
    let count: number | undefined;
    for (const { port, fieldWidth } of reads) {
      if (port.width === null) continue;
      if (port.width > MAX_TABLE_VECTOR || port.width % fieldWidth !== 0)
        throw new DiagramError("E204", "all-entry read width must be a multiple of its field width and at most 65536 bits", port.line);
      const rows = port.width / fieldWidth;
      if (count !== undefined && count !== rows)
        throw new DiagramError("E204", "all-entry reads of the same table must cover the same number of entries", port.line);
      count = rows;
    }
    for (const { port, fieldWidth } of reads) {
      if (port.width !== null) continue;
      if (count === undefined) {
        if (final) throw new DiagramError("E207", "cannot infer width of " + id + "." + port.name + "; specify read width or connect a sized port", port.line);
        continue;
      }
      const width = count * fieldWidth;
      if (width > MAX_TABLE_VECTOR)
        throw new DiagramError("E204", "generated all-entry vector exceeds 65536 bits", port.line);
      port.width = width;
      changed = true;
    }
  }
  return changed;
}
function resolve(d: Diagram): void {
  const tableVectors = tableVectorGroups(d);
  resolveTableVectors(tableVectors);
  for (const w of d.wirings) {
    for (const r of w.sources) if (role(d, r.endpoint, w.line) !== "source") throw new DiagramError("E103", `${signalToString(r)} cannot drive a net`, w.line);
    for (const r of w.sinks) if (role(d, r.endpoint, w.line) !== "sink") throw new DiagramError("E103", `${signalToString(r)} cannot receive a net`, w.line);
    for (const r of [...w.sources, ...w.sinks]) if (r.msb !== null && getPort(d, r.endpoint, w.line).width === null) throw new DiagramError("E207", `slice ${signalToString(r)} requires an explicitly sized port`, w.line);
  }
  for (let pass = 0; pass < Math.max(2, d.wirings.length * 3 + tableVectors.length + 1); pass++) {
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
    changed = resolveTableVectors(tableVectors) || changed;
    if (!changed) break;
  }
  resolveTableVectors(tableVectors, true);
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

/** Parse, validate and infer widths from a CDL source string. */
export interface ParseOptions { mode?: Diagram["mode"] }
export function parse(source: string, options: ParseOptions = {}): Diagram {
  if(options.mode!==undefined&&options.mode!=="circuit"&&options.mode!=="microarchitecture")throw new DiagramError("E202",`invalid mode ${String(options.mode)}`);
  const r = new Reader(source);
  if (r.is("version")) {
    const version = r.pop();
    if (r.integer() !== 1) throw new DiagramError("E002", "only version 1 is supported", version.line);
  }
  r.need("diagram");
  const title=r.string();r.need("{");
  const d:Diagram={title,mode:"circuit",direction:"LR",theme:"light",layout:"balanced",netlabels:true,ports:{},blocks:{},nets:[],wirings:[],groups:[]};
  const ranks:{id:string;rank:number;line:number}[]=[];
  const ids=()=>{const out=[r.word()];while(r.take(","))out.push(r.word());return out;};
  let declaredMode = false;
  while(!r.take("}")){
    if(r.is("<eof>"))r.fail("unterminated diagram");const t=r.t;
    if(r.is("direction")){r.pop();const x=r.word();if(!["LR","RL","TB","BT"].includes(x.value))r.fail("invalid direction");d.direction=x.value as Diagram["direction"];continue;}
    if(r.is("mode")&&r.ts[r.pos+1]?.kind==="word"){r.pop();const x=r.word();if(declaredMode)throw new DiagramError("E102","duplicate mode declaration",t.line);declaredMode=true;if(!["circuit","microarchitecture"].includes(x.value))throw new DiagramError("E202",`invalid mode ${x.value}`,x.line);d.mode=x.value as Diagram["mode"];continue;}
    if(r.is("theme")){r.pop();const x=r.word();if(!["light","dark","mono"].includes(x.value))r.fail("invalid theme");d.theme=x.value as Diagram["theme"];continue;}
    if(r.is("layout")){r.pop();const x=r.word();if(!["balanced","compact","feedback"].includes(x.value))r.fail("invalid layout");d.layout=x.value as Diagram["layout"];continue;}
    if(r.is("netlabels")){r.pop();const x=r.word();if(x.value!=="on"&&x.value!=="off")r.fail("invalid netlabels setting");d.netlabels=x.value==="on";continue;}
    if(r.is("input")||r.is("output")){const dir=r.pop().value as Direction, declared=r.ports(dir);for(const [pn,p]of Object.entries(declared)){if(d.ports[pn]||d.blocks[pn])throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(pn)}`,p.line);d.ports[pn]=p;}continue;}
    if(r.is("rank")&&r.ts[r.pos+1].kind==="int"){r.pop();const n=r.integer();r.need(":");for(const id of ids())ranks.push({id:id.value,rank:n,line:id.line});continue;}
    if(r.is("group")&&r.ts[r.pos+1].kind==="string"){r.pop();const label=r.string();r.need(":");d.groups.push({label,members:ids().map(x=>x.value),line:t.line});continue;}
    if(r.is("net")){
      r.pop();const name=r.word();let width:number|null=null;if(r.take("[")){width=r.integer();r.need("]");if(width===0)throw new DiagramError("E201",`net ${name.value} width must be positive`,t.line);}r.need("=");const sources=r.signalExpr();r.need("->");const sinks=[r.ref()];while(r.take(","))sinks.push(r.ref());d.wirings.push({sources,sinks,name:name.value,width,line:t.line});continue;
    }
    const connection=()=>{const start=r.t;const sources=r.signalExpr();if(!r.take("->"))r.fail("expected ':' for block declaration or '->' for connection");const sinks=[r.ref()];while(r.take(","))sinks.push(r.ref());d.wirings.push({sources,sinks,name:null,width:null,line:start.line});};
    if(r.is("{")){connection();continue;}
    if(t.kind!=="word")r.fail("expected declaration");const name=r.word();
    if(r.take(":")){
      if(name.value in d.blocks||name.value in d.ports)throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(name.value)}`,name.line);
      let type:string,label:string,params:Record<string,string|number>={};
      if(r.is("box")){r.pop();type="box";label=r.string();}else{type=r.word().value;label=type;if(type==="table")label=r.t.kind==="string"?r.string():"";if(type==="record")label=r.string();if(r.is("("))params=r.params();}
      const preset=validatePreset(type,params,name.line);const ports=preset??{};let style:string|null=null;let table:Table|undefined;let structuredTable:StructuredTable|undefined;let recordFields:MicroField[]|undefined;const tableBindings:TableBinding[]=[];const fields:MicroField[]=[];const indices:string[]=[];
      const orient:Pick<Block,"rotation"|"flipX"|"flipY"|"explicitRotation">={rotation:0,flipX:false,flipY:false};
      r.orientation(orient);
      if(type==="table"||type==="record"){
        if(type==="table"){
          const allowed=["entries","rows","ellipsis","selected"];for(const k of Object.keys(params))if(!allowed.includes(k))throw new DiagramError("E202",`unsupported structured table parameter: ${k}`,name.line);
          const entries=params.entries;
          if(entries!==undefined&&(typeof entries!=="number"||!Number.isSafeInteger(entries)||entries<1))throw new DiagramError("E202","table entries must be a positive safe integer",name.line);
          const rows=params.rows??Math.min(entries??5,5);
          if(typeof rows!=="number"||!Number.isSafeInteger(rows)||rows<1||rows>64||(entries!==undefined&&rows>entries))throw new DiagramError("E202","table rows must be from 1 to 64 and no greater than entries when specified",name.line);
          const canShowEllipsis=rows>=3&&(entries===undefined||entries>rows);
          const ell=params.ellipsis??(canShowEllipsis?"on":"off");
          if(ell!=="on"&&ell!=="off")throw new DiagramError("E202","table ellipsis must be on or off",name.line);
          if(ell==="on"&&!canShowEllipsis)throw new DiagramError("E202","ellipsis needs at least three rows and room for hidden entries",name.line);
          const selected=params.selected??null;if(selected!==null&&(typeof selected!=="number"||!Number.isSafeInteger(selected)||selected<0||selected>=rows||(ell==="on"&&selected===rows-2)))throw new DiagramError("E202","selected must identify a visible non-ellipsis row",name.line);
          structuredTable={...(entries===undefined?{}:{entries}),rows,ellipsis:ell==="on",selected:selected as number|null,fields,indices};
        } else { if(Object.keys(params).length)throw new DiagramError("E202","record does not accept parameters",name.line);recordFields=fields; }
      }
      // A leading concatenation after the declaration also begins with "{".
      const next=r.ts[r.pos+1], after=r.ts[r.pos+2];
      const body=r.is("{")&&(next.value==="}"||next.kind==="word"&&after?.value!==","&&after?.value!=="."&&after?.value!=="[");
      if(body&&r.take("{")){while(!r.take("}")){if(r.is("table")){const token=r.pop();if(type!=="box")throw new DiagramError("E202","table is only supported inside box blocks",token.line);if(table)throw new DiagramError("E102","duplicate table declaration",token.line);table=parseTable(r.params(),token.line);}
          else if((r.is("field")||r.is("index")||r.is("read")||r.is("write"))&&(type==="table"||type==="record")){
            const kind=r.pop();
            if(kind.value==="field") {const fn=r.word();r.need("[");const width=r.integer();r.need("]");if(!Number.isSafeInteger(width)||width<1)throw new DiagramError("E201","field width must be a positive safe integer",fn.line);let flabel=fn.value,use:string|null=null;if(r.take("label"))flabel=r.string();if(r.take("use"))use=r.string();if(fields.some(f=>f.id===fn.value))throw new DiagramError("E102",`duplicate field ${fn.value}`,fn.line);fields.push({id:fn.value,width,label:flabel,use,msb:0,lsb:0});}
            else if(kind.value==="index") {
              const pn=r.word();
              if(!structuredTable)throw new DiagramError("E202","records do not have indices",pn.line);
              const width=r.optionalBindingWidth(pn);
              const side=r.take("@")?r.word().value:"west";
              if(side!=="west"&&side!=="east")throw new DiagramError("E202","table index decoders must be on the west or east side",pn.line);
              const capacity=structuredTable.entries;
              const expected=capacity===undefined?null:Math.max(1,Math.ceil(Math.log2(capacity)));
              if(width!==null&&expected!==null&&width!==expected)throw new DiagramError("E204",`index width must be ${expected}`,pn.line);
              if(ports[pn.value])throw new DiagramError("E102",`duplicate port ${pn.value}`,pn.line);
              ports[pn.value]={name:pn.value,direction:"input",width:width??expected,side,line:pn.line};
              indices.push(pn.value);
            } else {
              const pn=r.word();
              if(!structuredTable)throw new DiagramError("E202","records do not have read/write ports",pn.line);
              const width=r.optionalBindingWidth(pn);
              const isRead=kind.value==="read";
              r.need(isRead?"from":"to");
              const field=r.word(),all=isRead&&r.take("all");
              const via=r.take("via")?r.word().value:undefined;
              if(all&&via!==undefined)throw new DiagramError("E202","all-entry reads cannot select an index",pn.line);
              const required=isRead?"south":"north",side=r.take("@")?r.word().value:required;
              if(side!==required)throw new DiagramError("E202",`${kind.value} table ports must attach on @${required}`,pn.line);
              if(ports[pn.value])throw new DiagramError("E102",`duplicate port ${pn.value}`,pn.line);
              ports[pn.value]={name:pn.value,direction:isRead?"output":"input",width,side,line:pn.line};
              tableBindings.push({port:pn.value,field:field.value,kind:isRead?"read":"write",all,side,...(via===undefined?{}:{index:via})});
            }
          }
          else if(r.is("style")){r.pop();style=r.word().value;if(!["logic","storage","control","neutral","accent"].includes(style))r.fail("invalid style");}
          else if(r.is("label")){r.pop();label=r.string();}
          else if(r.is("rank")){const token=r.pop();ranks.push({id:name.value,rank:r.integer(),line:token.line});}
          else if(r.is("rotate")){r.pop();const deg=r.integer();if(![0,90,180,270].includes(deg))r.fail("rotate must be 0, 90, 180 or 270");orient.rotation=deg as Block["rotation"];orient.explicitRotation=true;}
          else if(r.take("flipx"))orient.flipX=true;
          else if(r.take("flipy"))orient.flipY=true;
          else if(r.is("in")||r.is("out")){const local=r.pop(), dir:Direction=local.value==="in"?"input":"output", extras=r.ports(dir);if(type==="record")throw new DiagramError("E202","record ports are generated from its fields",local.line);for(const [pn,p]of Object.entries(extras)){if(ports[pn]){const old=ports[pn];if(!preset||old.direction!==p.direction||(p.width!==null&&p.width!==old.width))throw new DiagramError("E102",`incompatible duplicate port ${name.value}.${pn}`,p.line);if(p.side){old.side=p.side;old.explicitSide=true;}}else{if(preset)throw new DiagramError("E102",`cannot add port ${JSON.stringify(pn)} to builtin ${type}`,p.line);ports[pn]=p;}}}
          else r.fail("expected block body declaration");}}
      if(structuredTable){
        if(!fields.length)throw new DiagramError("E202","structured table requires at least one field",name.line);
        let cursor=fields.reduce((n,f)=>n+f.width,0);if(!Number.isSafeInteger(cursor))throw new DiagramError("E204","record total width exceeds safe integer range",name.line);for(const f of fields){f.msb=cursor-1;cursor-=f.width;f.lsb=cursor;}
        for(const binding of tableBindings){
          const port=ports[binding.port],field=fields.find(f=>f.id===binding.field);
          if(!field)throw new DiagramError("E101",`unknown table field ${binding.field}`,port.line);
          if(binding.index!==undefined&&!structuredTable.indices.includes(binding.index))
            throw new DiagramError("E101",`unknown table index ${binding.index}`,port.line);
          const count=binding.all?structuredTable.entries:1;
          if(count===undefined)continue;
          const width=field.width*count;
          if(width>MAX_TABLE_VECTOR)throw new DiagramError("E204","generated table port exceeds 65536 bits",port.line);
          if(port.width!==null&&port.width!==width)throw new DiagramError("E204",`table port ${port.name} must be ${width} bits`,port.line);
          port.width=width;
        }
      }
      if(type==="record"){
        if(!fields.length)throw new DiagramError("E202","record requires at least one field",name.line);let cursor=fields.reduce((n,f)=>n+f.width,0);if(!Number.isSafeInteger(cursor))throw new DiagramError("E204","record total width exceeds safe integer range",name.line);for(const f of fields){f.msb=cursor-1;cursor-=f.width;f.lsb=cursor;}
        if(ports.IN)throw new DiagramError("E102","record field id conflicts with generated IN port",name.line);ports.IN={name:"IN",direction:"input",width:fields.reduce((n,f)=>n+f.width,0),side:"north",line:name.line};
        for(const f of fields){if(ports[f.id])throw new DiagramError("E102",`record field id conflicts with port ${f.id}`,name.line);ports[f.id]={name:f.id,direction:"output",width:f.width,side:"south",line:name.line};}
      }
      if(!Object.keys(ports).length&&type!=="table")throw new DiagramError("E203",`${name.value} has no ports; declare them using a block body`,name.line);
      d.blocks[name.value]={id:name.value,type,label,ports,params,line:name.line,builtin:preset!==null,style,rank:null,...orient,...(table?{table}:{}),...(structuredTable?{structuredTable}:{}),...(recordFields?{recordFields}:{}),...(tableBindings.length?{tableBindings}:{})};continue;
    }
    r.pos--;connection();
  }
  if(!r.is("<eof>"))r.fail("unexpected content after diagram");
  for(const p of Object.values(d.ports))if(d.blocks[p.name])throw new DiagramError("E102",`duplicate identifier ${JSON.stringify(p.name)}`,p.line);
  d.mode=options.mode??d.mode;
  if(d.mode==="circuit"&&Object.values(d.blocks).some(b=>b.structuredTable||b.recordFields))throw new DiagramError("E202","structured tables and address records require microarchitecture mode");
  for(const x of ranks){const b=d.blocks[x.id];if(!b)throw new DiagramError("E101",d.ports[x.id]?`rank applies to blocks only; diagram port ${JSON.stringify(x.id)} is placed automatically`:`unknown block ${JSON.stringify(x.id)} in rank`,x.line);if(b.rank!==null&&b.rank!==x.rank)throw new DiagramError("E106",`conflicting ranks ${b.rank} and ${x.rank} for ${JSON.stringify(x.id)}`,x.line);b.rank=x.rank;}
  for(const g of d.groups){const seen=new Set<string>();for(const m of g.members){if(!d.blocks[m])throw new DiagramError("E101",`unknown block ${JSON.stringify(m)} in group ${JSON.stringify(g.label)}`,g.line);if(seen.has(m))throw new DiagramError("E102",`duplicate member ${JSON.stringify(m)} in group ${JSON.stringify(g.label)}`,g.line);seen.add(m);}}
  resolve(d);return d;
}
