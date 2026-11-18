/** Diagram cells for slices and concatenations. The raw Yosys dump still uses bit aliases. */
export interface DiagramCell {
  hide_name: number;
  type: string;
  parameters: Record<string,number>;
  attributes: Record<string,string|number>;
  port_directions: Record<string,"input"|"output">;
  connections: Record<string,number[]>;
}
export interface DiagramModule {
  ports: Record<string,{ direction: "input"|"output"; bits: number[] }>;
  cells: Record<string,DiagramCell>;
  netnames: Record<string,{ hide_name:number; bits:number[]; attributes:Record<string,string> }>;
}
export interface BusAdapter {
  id:string;
  kind:"split"|"join";
  lanes:{ name:string; range:string }[];
}

export const busAlias = (id:string) => "CDL_BUS__" + id;
const range = (msb:number,lsb:number) => msb===lsb?String(lsb):msb+":"+lsb;

/** Replace bit aliases with whole-vector diagram wires on either side of the adapters. */
export function addBusAdapters(mod:DiagramModule):BusAdapter[] {
  const owner=new Map<number,{ bus:number[]; offset:number }>();
  const sinks:{ bits:number[]; assign:(bits:number[])=>void }[]=[];
  let next=2;
  const visit=(bits:number[],drives:boolean,assign:(bits:number[])=>void)=>{
    bits.forEach((bit,offset)=>{
      next=Math.max(next,bit+1);
      if(drives)owner.set(bit,{bus:bits,offset});
    });
    if(!drives)sinks.push({bits,assign});
  };
  for(const p of Object.values(mod.ports))visit(p.bits,p.direction==="input",bits=>{p.bits=bits;});
  for(const cell of Object.values(mod.cells))for(const [name,bits] of Object.entries(cell.connections))
    visit(bits,cell.port_directions[name]==="output",value=>{cell.connections[name]=value;});

  const newBits=(width:number)=>Array.from({length:width},()=>next++);
  const adapters:BusAdapter[]=[];
  const splits=new Map<number[],{ adapter:BusAdapter; cell:DiagramCell; outputs:Map<string,number[]> }>();
  const replacements=new Map<string,number[]>();
  const make=(kind:BusAdapter["kind"])=>{
    // '$' cannot occur in CDL identifiers.
    const id="$bus$"+adapters.length;
    const adapter:BusAdapter={id,kind,lanes:[]};
    const cell:DiagramCell={hide_name:1,type:busAlias(id),parameters:{},attributes:{},port_directions:{},connections:{}};
    adapters.push(adapter);
    mod.cells[id]=cell;
    return {adapter,cell};
  };
  const connect=(cell:DiagramCell,name:string,direction:"input"|"output",bits:number[])=>{
    cell.connections[name]=bits;
    cell.port_directions[name]=direction;
  };
  const slice=(bus:number[],lo:number,width:number)=>{
    if(lo===0&&width===bus.length)return bus;
    let split=splits.get(bus);
    if(!split){
      split={...make("split"),outputs:new Map()};
      connect(split.cell,"A","input",bus);
      splits.set(bus,split);
    }
    const label=range(lo+width-1,lo);
    const old=split.outputs.get(label);
    if(old)return old;
    const pin="Y"+split.adapter.lanes.length,bits=newBits(width);
    split.adapter.lanes.push({name:pin,range:label});
    connect(split.cell,pin,"output",bits);
    split.outputs.set(label,bits);
    replacements.set(bus.slice(lo,lo+width).join(","),bits);
    return bits;
  };
  for(const sink of sinks){
    const key=sink.bits.join(",");
    const reused=replacements.get(key);
    if(reused){sink.assign(reused);continue;}
    const parts:{ bus?:number[]; start:number; bits:number[] }[]=[];
    for(const bit of sink.bits){
      const source=owner.get(bit), last=parts.at(-1);
      if(last&&last.bus===source?.bus&&(!source||last.start+last.bits.length===source.offset))last.bits.push(bit);
      else parts.push({bus:source?.bus,start:source?.offset??0,bits:[bit]});
    }
    if(!parts.some(part=>part.bus))continue;
    if(parts.length===1){
      const part=parts[0];
      sink.assign(slice(part.bus!,part.start,part.bits.length));
      continue;
    }
    const {adapter,cell}=make("join");
    let msb=sink.bits.length-1;
    for(const part of parts.reverse()){
      const width=part.bits.length, lsb=msb-width+1, pin="A"+adapter.lanes.length;
      adapter.lanes.push({name:pin,range:range(msb,lsb)});
      connect(cell,pin,"input",part.bus?slice(part.bus,part.start,width):part.bits);
      msb=lsb-1;
    }
    const bits=newBits(sink.bits.length);
    connect(cell,"Y","output",bits);
    replacements.set(key,bits);
    sink.assign(bits);
  }
  for(const adapter of adapters) if(adapter.kind==="split")
    adapter.lanes.sort((a,b)=>Number.parseInt(b.range)-Number.parseInt(a.range));
  for(const net of Object.values(mod.netnames))net.bits=replacements.get(net.bits.join(","))??net.bits;
  return adapters;
}
