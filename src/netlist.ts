import { DiagramError, type Diagram, type SignalRef } from "./model.js";
import { hasPlacedPorts, interfaceAlias, interfacePin } from "./interface-ports.js";
import { addBusAdapters, type DiagramModule } from "./bus-adapters.js";

const SKIN_TYPES: Record<string,string> = { ADD:"$add",SUB:"$sub",MUX:"$mux",DFF:"$dff",CMP:"$eq",SHIFT:"$shl",SHL:"$shl",SHR:"$shr",SAR:"$sshr",AND:"$and",OR:"$or",NOT:"$not",XOR:"$xor" };
const bitsOf = <T>(ref: SignalRef, endpoints: Record<string,T[]>): T[] => {
  const bits=endpoints[ref.endpoint];return ref.msb===null?[...bits]:bits.slice(ref.lsb!,ref.msb+1);
};

export function compileNetlist(diagram: Diagram, customSkin = false) {
  const parent=new Map<string,string>(), endpointBits:Record<string,number[]>={};
  const addEndpoint=(ep:string,width:number|null)=>{const nodes:string[]=[];for(let i=0;i<(width??1);i++){const n=`${ep}:${i}`;parent.set(n,n);nodes.push(n);}endpointBits[ep]=nodes.map((_,i)=>i);};
  for(const [name,p]of Object.entries(diagram.ports))addEndpoint(name,p.width);
  for(const [id,b]of Object.entries(diagram.blocks))for(const [pn,p]of Object.entries(b.ports))addEndpoint(`${id}.${pn}`,p.width);
  const root=(n:string):string=>{let p=parent.get(n)!;if(p!==n){p=root(p);parent.set(n,p);}return p;};
  const union=(a:string,b:string)=>{const ra=root(a),rb=root(b);if(ra!==rb)parent.set(rb,ra);};
  const rawBits:Record<string,string[]>={};
  for(const ep of Object.keys(endpointBits))rawBits[ep]=[...parent.keys()].filter(x=>x.startsWith(`${ep}:`));
  for(const w of diagram.wirings){const src=[...w.sources].reverse().flatMap(s=>bitsOf(s,rawBits));for(const sink of w.sinks){const dst=bitsOf(sink,rawBits);if(src.length!==dst.length)throw new DiagramError("E204","inconsistent connection length in backend",w.line);src.forEach((a,i)=>union(a,dst[i]));}}
  const ids=new Map<string,number>();let next=2;const vectors:Record<string,number[]>={};
  for(const [ep,nodes]of Object.entries(rawBits)){vectors[ep]=nodes.map(n=>{const rep=root(n);if(!ids.has(rep))ids.set(rep,next++);return ids.get(rep)!;});}
  const netnames:DiagramModule["netnames"]={};
  for(const w of diagram.wirings)if(w.name){const bits=[...w.sources].reverse().flatMap(s=>bitsOf(s,vectors));const old=netnames[w.name];if(old&&JSON.stringify(old.bits)!==JSON.stringify(bits))throw new DiagramError("E104",`conflicting named net ${JSON.stringify(w.name)}`);netnames[w.name]={hide_name:0,bits,attributes:{}};}
  const cells:DiagramModule["cells"]={};
  for(const [id,b]of Object.entries(diagram.blocks)){const connections:Record<string,number[]>={},port_directions:DiagramModule["cells"][string]["port_directions"]={};for(const [pn,p]of Object.entries(b.ports)){connections[pn]=vectors[`${id}.${pn}`];port_directions[pn]=p.direction;}
    const wideMux=b.type==="MUX"&&Number(b.params.inputs??2)>2;
    const cellType=b.type==="CMP"&&b.params.op==="ne"?"$ne":wideMux?"MUX":SKIN_TYPES[b.type]??(b.type==="box"?b.label:b.type);
    const attributes:DiagramModule["cells"][string]["attributes"]={name:b.label};
    if(b.rank!=null)attributes["org.eclipse.elk.partitioning.partition"]=b.rank;
    const cell:DiagramModule["cells"][string]={hide_name:0,type:customSkin?`CDL__${id}`:cellType,parameters:{},attributes,port_directions,connections};
    if(!customSkin&&["MUX","DFF"].includes(b.type))cell.parameters.WIDTH=Number(b.params.width??32);cells[id]=cell;
  }
  const ports:DiagramModule["ports"]={};
  const usePortSymbols=customSkin&&hasPlacedPorts(diagram);
  for(const [name,p]of Object.entries(diagram.ports)){
    if(usePortSymbols){
      const pin=interfacePin(p.direction);
      cells[name]={hide_name:0,type:interfaceAlias(name),parameters:{},attributes:{},port_directions:{[pin]:p.direction==="input"?"output":"input"},connections:{[pin]:vectors[name]}};
    }else ports[name]={direction:p.direction,bits:vectors[name]};
  }
  const top={attributes:{top:1},ports,cells,netnames};
  const adapters=customSkin&&diagram.direction!=="LR"?addBusAdapters(top):[];
  return {netlist:{creator:"cdiag 0.4",modules:{top}},adapters};
}

/** Produce the Yosys-compatible netlist consumed by Netlist2SVG. */
export function yosysJson(diagram: Diagram, customSkin = false) {
  return compileNetlist(diagram,customSkin).netlist;
}
