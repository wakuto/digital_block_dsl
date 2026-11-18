import type { Block, Diagram, Port, Side } from "./model.js";
import { defaultStyle } from "./symbols.js";
import { textWidth } from "./table.js";
import { orderedSlots, type PinOrders } from "./pin-order.js";
import { busAlias, type BusAdapter } from "./bus-adapters.js";
import { compileNetlist } from "./netlist.js";
import { defaultInterfaceSide, hasPlacedPorts, interfaceAlias, interfacePin, interfaceShape, interfaceSide, layoutDirection } from "./interface-ports.js";

export const SKIN_NS="https://github.com/ajsb85/netlist2svg", SVG_NS="http://www.w3.org/2000/svg";
export const PALETTES={
  light:{ink:"#253858",wire:"#344b66",paper:"#ffffff",logic:"#e7f0fc",storage:"#e5f5ee",control:"#f0ecff",neutral:"#f4f6fa",accent:"#fff0cd"},
  dark:{ink:"#dbeafe",wire:"#b3c9ea",paper:"#142033",logic:"#23446b",storage:"#185348",control:"#433268",neutral:"#263b53",accent:"#71551d"},
  mono:{ink:"#242424",wire:"#333333",paper:"#ffffff",logic:"#ffffff",storage:"#ffffff",control:"#ffffff",neutral:"#ffffff",accent:"#eeeeee"}
};
const PRESETS={compact:{layers:24,nodes:20,edge:12},balanced:{layers:45,nodes:38,edge:20},feedback:{layers:36,nodes:46,edge:25}};
type Palette=typeof PALETTES.light;
const esc=(v:unknown)=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
const tag=(name:string,attrs:Record<string,unknown>={},content?:string)=>content===undefined?`<${name}${Object.entries(attrs).map(([k,v])=>` ${k}="${esc(v)}"`).join("")}/>`:`<${name}${Object.entries(attrs).map(([k,v])=>` ${k}="${esc(v)}"`).join("")}>${esc(content)}</${name}>`;
const trapInset=30;
const compact=new Set(["ADD","SUB","SHIFT","SHL","SHR","SAR","CMP","AND","OR","XOR","NOT"]);
const autoOriented=new Set([...compact,"ALU","MUX","DEMUX"]);
const tableRowHeight=30;
const facing=["west","north","east","south"] as const;
const flowTurn={LR:0,TB:1,RL:2,BT:3} as const;
const rotationFlow=["LR","TB","RL","BT"] as const;
type Flow=Diagram["direction"];

// Turn the outline only. ELK needs the anchors in the final coordinate frame.
// Text is positioned in that same frame so it stays upright.
function drawingFrame(flow:Flow,w:number,h:number,flipX=false,flipY=false){
 const turn=flowTurn[flow];
 const matrix=flow==="TB"?[0,1,-1,0,h,0]:flow==="RL"?[-1,0,0,-1,w,h]:flow==="BT"?[0,-1,1,0,0,w]:[1,0,0,1,0,0];
 const quarter=turn%2===1;
 const width=quarter?h:w,height=quarter?w:h;
 if(flipX){matrix[0]*=-1;matrix[2]*=-1;matrix[4]=width-matrix[4];}
 if(flipY){matrix[1]*=-1;matrix[3]*=-1;matrix[5]=height-matrix[5];}
 const [a,b,c,d,e,f]=matrix;
 const turned=turn!==0||flipX||flipY;
 return {
   width,height,turned,
   outline:(shape:string)=>turned?`<g transform="matrix(${matrix.join(",")})">${shape}</g>`:shape,
   point:(x:number,y:number):[number,number]=>[a*x+c*y+e,b*x+d*y+f],
   side:(side:Side):Side=>{
     const next=(facing.indexOf(side)+turn)%4;
     return (next%2===0?flipX:flipY)?facing[(next+2)%4]:facing[next];
   },
   // A, B, ... stay in reading order along the edge after the turn.
   index:(side:Side,i:number,n:number)=>{
     const step=side==="west"||side==="east"?(c||d):(a||b);
     return step<0?n-1-i:i;
   },
 };
}
const portInward:Record<Side,[number,number]>={west:[1,0],east:[-1,0],north:[0,1],south:[0,-1]};

/** Prefer full grid lines and preserve separation when several ports share an edge. */
function gridSlot(offset:number, spacing:number):number {
 const grid=Math.round(offset/10)*10;
 if(spacing>=10&&Math.abs(grid-offset)<=3.5)return grid;
 return spacing>=5?Math.round(offset/5)*5:offset;
}

function busAdapterSvg(adapter:BusAdapter,pal:Palette,flow:Flow):string {
 const split=adapter.kind==="split", quarter=flow==="TB"||flow==="BT";
 const labelWidth=Math.max(...adapter.lanes.map(lane=>textWidth(lane.range)));
 const gap=quarter?Math.ceil(Math.max(23,labelWidth+7)):22;
 const span=gap*(adapter.lanes.length+1), rail=5, depth=rail+(quarter?18:Math.max(20,labelWidth+8));
 const frame=drawingFrame(flow,depth,span);
 const railX=split?0:depth-rail, laneSide=split?"east":"west";
 const left=frame.point(railX,0), right=frame.point(railX+rail,span);
 let out=`<g s:type="cdiag_bus_${adapter.kind}" transform="translate(0,0)" s:width="${frame.width}" s:height="${frame.height}" id="cell_${esc(adapter.id)}">`;
 out+=tag("s:alias",{val:busAlias(adapter.id)});
 out+=tag("rect",{x:Math.min(left[0],right[0]),y:Math.min(left[1],right[1]),width:Math.abs(right[0]-left[0]),height:Math.abs(right[1]-left[1]),class:"splitjoinBody",stroke:"none"});
 const pin=(name:string,x:number,y:number)=>tag("g",{"s:x":x,"s:y":y,"s:pid":name});
 out+=pin(split?"A":"Y",...frame.point(split?0:depth,span/2));
 for(const [i,lane] of adapter.lanes.entries()){
   const step=frame.index(laneSide,i,adapter.lanes.length)+1;
   const [x,y]=frame.point(split?depth:0,gap*step);
   const [x1,y1]=frame.point(split?rail:depth-rail,gap*step);
   out+=tag("line",{x1,y1,x2:x,y2:y});
   const side=frame.side(laneSide);
   const lx=quarter?x+4:(x+x1)/2, ly=quarter?y+(side==="north"?12:-5):y-4;
   out+=tag("text",{x:lx,y:ly,"text-anchor":quarter?"start":"middle",fill:pal.ink},lane.range);
   out+=pin(lane.name,x,y);
 }
 return out+"</g>";
}
function markedPin(p:Port,side:Side,x:number,y:number,ink:string,clearance=0):string {
 const [dx,dy]=portInward[side];
 const boundary=[x+clearance*dx,y+clearance*dy];
 const inner=[boundary[0]+7*dx,boundary[1]+7*dy];
 const [[tx,ty],[bx,by]]=p.direction==="input"?[inner,boundary]:[boundary,inner];
 const point=(px:number,py:number)=>`${px.toFixed(2)},${py.toFixed(2)}`;
 return tag("path",{
   class:"port-arrow","data-port":p.name,
   d:`M ${point(tx,ty)} L ${point(bx-3.5*dy,by+3.5*dx)} L ${point(bx+3.5*dy,by-3.5*dx)} Z`,
   fill:ink,stroke:"none",
 })+tag("g",{"s:x":x.toFixed(2),"s:y":y.toFixed(2),"s:pid":p.name});
}

function muxSvg(b:Block,pal:Palette,sides:Record<Side,Port[]>,flow:Flow):string {
 const data=Object.values(b.ports).filter(p=>p.direction==="input"&&p.name!=="S");
 const vertical=data.every(p=>p.side==="north")&&b.ports.Y?.side==="south";
 // Keep the same slope at every size, as in the circuit symbol.
 const depth=trapInset;
 const inputCount=vertical?sides.north.length:sides.west.length;
 const outputCount=vertical?sides.south.length:sides.east.length;
 const span=Math.ceil(Math.max(78,24*inputCount+30,2*depth+9*outputCount)/10)*10;
 const w=vertical?span:depth,h=vertical?depth:span;
 const frame=drawingFrame(flow,w,h,b.flipX,b.flipY);
 const outline=vertical
   ?`M 0,0 L ${span},0 L ${span-depth},${depth} L ${depth},${depth} Z`
   :`M 0,0 L ${depth},${depth} L ${depth},${span-depth} L 0,${span} Z`;
 const fill=pal[defaultStyle(b) as keyof Palette]??pal.neutral;
 let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${frame.width}" s:height="${frame.height}" id="cell_${esc(b.id)}"><s:alias val="CDL__${esc(b.id)}"/>`;
 out+=frame.outline(tag("path",{stroke:pal.ink,"stroke-width":1.6,fill,class:"symbol $cell_id",d:outline}));
 for(const side of ["west","east","north","south"] as const){
   const ports=[...sides[side]];
   if(vertical&&side==="north"&&b.ports.S?.side==="north"){
     ports.splice(ports.indexOf(b.ports.S),1);
     ports.splice(Math.floor(ports.length/2),0,b.ports.S);
   }
   ports.forEach((p,order)=>{
     const i=frame.index(side,order,ports.length);
     const f=(i+1)/(ports.length+1), narrowSpan=span-2*depth;
     const wide=gridSlot(span*f,span/(ports.length+1));
     const narrow=depth+gridSlot(narrowSpan*(i+.5)/ports.length,narrowSpan/ports.length);
     const diagonal=gridSlot(depth*f,depth/(ports.length+1));
     const [x,y]=vertical
       ? side==="north"?[wide,0]:side==="south"?[narrow,depth]:[side==="west"?diagonal:span-diagonal,diagonal]
       : side==="west"?[0,wide]:side==="east"?[depth,narrow]:[diagonal,side==="north"?diagonal:span-diagonal];
     const [px,py]=frame.point(x,y),edge=frame.side(side);
     out+=markedPin(p,edge,px,py,pal.ink);
   });
 }
 return out+"</g>";
}
function tableSvg(b:Block,pal:Palette):string {
 const t=b.table!, titles=b.label.split("\n"), top=10+titles.length*20;
 const indexWidth=Math.max(0,...t.indices.map(textWidth));
 const left=(t.brace!==null?textWidth(t.brace)+24:0)+(t.indices.length?indexWidth+12:0);
 const widths=t.columns.map(label=>Math.max(64,textWidth(label)+20));
 const gridWidth=Math.max(widths.reduce((a,v)=>a+v,0),...titles.map(textWidth));
 const scale=gridWidth/widths.reduce((a,v)=>a+v,0);let x=left;
 const centers=widths.map(width=>{const center=x+width*scale/2;x+=width*scale;return center;});
 const gridHeight=t.rows*tableRowHeight, w=left+gridWidth,h=top+gridHeight;
 let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${w}" s:height="${h}" id="cell_${esc(b.id)}"><s:alias val="CDL__${esc(b.id)}"/>`;
 titles.forEach((title,i)=>{out+=tag("text",{x:left+gridWidth/2,y:16+i*20,"text-anchor":"middle","font-size":13,fill:pal.ink},title);});
 out+=tag("rect",{x:left,y:top,width:gridWidth,height:gridHeight,fill:pal[defaultStyle(b) as keyof Palette]??pal.neutral,stroke:pal.ink,"stroke-width":1.5,class:"symbol $cell_id"});
 x=left; widths.slice(0,-1).forEach(width=>{x+=width*scale;out+=tag("line",{x1:x,y1:top,x2:x,y2:h});});
 for(let i=0;i<t.rows;i++){
   const y=top+i*tableRowHeight, center=y+tableRowHeight/2;
   if(i)out+=tag("line",{x1:left,y1:y,x2:w,y2:y});
   if(i===0)t.columns.forEach((label,c)=>{if(label)out+=tag("text",{x:centers[c],y:center+4,"text-anchor":"middle","font-size":12,fill:pal.ink},label);});
   if(t.ellipsis&&i===t.rows-2)centers.forEach(cx=>{for(const dy of [-7,0,7])out+=tag("circle",{cx,cy:center+dy,r:2.3,fill:pal.ink,stroke:"none"});});
   if(t.indices[i])out+=tag("text",{x:left-8,y:center+4,"text-anchor":"end",fill:pal.ink},t.indices[i]);
 }
 if(t.brace!==null){const bx=left-indexWidth-(t.indices.length?16:0)-10, mid=top+gridHeight/2;
   out+=tag("path",{d:`M ${bx+8},${top} Q ${bx},${top} ${bx},${top+12} L ${bx},${mid-12} Q ${bx},${mid} ${bx-8},${mid} Q ${bx},${mid} ${bx},${mid+12} L ${bx},${h-12} Q ${bx},${h} ${bx+8},${h}`,stroke:pal.ink,fill:"none"});
   if(t.brace)out+=tag("text",{x:bx-12,y:mid+4,"text-anchor":"end",fill:pal.ink},t.brace);
 }
 for(const side of ["west","east","north","south"] as Side[]){
   const ports=Object.values(b.ports).filter(p=>(p.side??(p.direction==="input"?"west":"east"))===side);
   ports.forEach((p,i)=>{
     const horizontal=side==="north"||side==="south";
     const px=horizontal?(ports.length<=centers.length?centers[i]:left+gridWidth*(i+1)/(ports.length+1)):(side==="west"?left:w);
     const py=horizontal?(side==="north"?top:h):top+gridHeight*(i+1)/(ports.length+1);
     out+=`<g s:x="${px}" s:y="${py}" s:pid="${esc(p.name)}"/>`;
   });
 }
 return out+"</g>";
}
function structuredTableSvg(b:Block,pal:Palette):string {
 const t=b.structuredTable!, title=b.label ? b.label.split("\n") : [];
 const ports=Object.values(b.ports), indexNames=new Set(t.indices);
 const fieldByPort=new Map((b.tableBindings??[]).map(binding=>[binding.port,binding.field]));
 const onSide=(side:Side)=>ports.filter(p=>(p.side??(p.direction==="input"?"west":"east"))===side);
 const left=onSide("west").some(p=>indexNames.has(p.name))?26:0;
 const right=onSide("east").some(p=>indexNames.has(p.name))?26:0;
 const names=t.fields.map(f=>`${f.label} [${f.width}]`);
 const widths=names.map(name=>Math.max(76,textWidth(name)+18));
 const minWidth=widths.reduce((sum,width)=>sum+width,0);
 const width=Math.max(minWidth,...title.map(text=>textWidth(text)+24));
 const extra=(width-minWidth)/widths.length;
 let x=left;
 const columns=t.fields.map((f,i)=>{
   const column={id:f.id,label:names[i],x,width:widths[i]+extra};
   x+=column.width;
   return column;
 });
 const titleH=title.length ? 10+title.length*20 : 0;
 const dataTop=titleH+tableRowHeight, dataH=t.rows*tableRowHeight, height=dataTop+dataH;
 const gridRight=left+width;
 let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${gridRight+right}" s:height="${height}" id="cell_${esc(b.id)}"><s:alias val="CDL__${esc(b.id)}"/>`;
 const pin=(p:Port,px:number,py:number)=>{out+=`<g s:x="${px}" s:y="${py}" s:pid="${esc(p.name)}"/>`;};
 const fill=pal[defaultStyle(b) as keyof Palette]??pal.neutral;
 out+=tag("rect",{x:left,y:0,width,height,fill,stroke:pal.ink,"stroke-width":1.5,class:"symbol $cell_id"});
 if(t.selected!==null){
   out+=tag("rect",{x:left+1,y:dataTop+t.selected*tableRowHeight,width:width-2,height:tableRowHeight-1,fill:pal.accent,stroke:"none"});
 }
 const rule=(y:number)=>tag("line",{x1:left,y1:y,x2:gridRight,y2:y,stroke:pal.ink});
 if(titleH)out+=rule(titleH);
 title.forEach((line,i)=>out+=tag("text",{x:left+width/2,y:19+i*20,"text-anchor":"middle","font-size":13,"font-weight":"bold",fill:pal.ink},line));
 for(const column of columns){
   const labelX=column.x+column.width/2;
   if(column.x!==left)out+=tag("line",{x1:column.x,y1:titleH,x2:column.x,y2:height,stroke:pal.ink});
   out+=tag("text",{x:labelX,y:titleH+18,"text-anchor":"middle","font-size":10,"font-weight":"bold",fill:pal.ink},column.label);
   if(t.ellipsis)for(const dy of [-6,0,6])out+=tag("circle",{cx:labelX,cy:dataTop+(t.rows-1.5)*tableRowHeight+dy,r:1.5,fill:pal.ink,stroke:"none"});
 }
 for(let i=0;i<t.rows;i++)out+=rule(dataTop+i*tableRowHeight);
 for(const side of ["north","south"] as const){
   const sidePorts=onSide(side), y=side==="north"?0:height;
   const occupied=[left,gridRight];
   for(const column of columns){
     const group=sidePorts.filter(p=>fieldByPort.get(p.name)===column.id);
     group.forEach((p,i)=>{
       const px=column.x+column.width/2+(i-(group.length-1)/2)*Math.min(16,column.width/(group.length+1));
       occupied.push(px);
       pin(p,px,y);
     });
   }
   // Place unbound control ports between the field ports without shifting them.
   occupied.sort((a,b)=>a-b);
   for(const p of sidePorts.filter(p=>!fieldByPort.has(p.name))){
     let gap=1;
     for(let i=2;i<occupied.length;i++)if(occupied[i]-occupied[i-1]>occupied[gap]-occupied[gap-1])gap=i;
     const px=(occupied[gap]+occupied[gap-1])/2;
     occupied.splice(gap,0,px);
     pin(p,px,y);
   }
 }
 for(const side of ["west","east"] as const){
   const sidePorts=onSide(side), indices=sidePorts.filter(p=>indexNames.has(p.name));
   const controls=sidePorts.filter(p=>!indexNames.has(p.name));
   const baseX=side==="west"?left:gridRight, apexX=baseX+(side==="west"?-24:24);
   indices.forEach((p,i)=>{
     const y1=dataTop+dataH*i/indices.length, y2=dataTop+dataH*(i+1)/indices.length, cy=(y1+y2)/2;
     out+=tag("path",{d:`M ${baseX},${y1} L ${apexX},${cy} L ${baseX},${y2} Z`,fill,stroke:pal.ink,"stroke-width":1.5,class:"symbol $cell_id","data-index":p.name});
     pin(p,apexX,cy);
   });
   // Keep control wires clear of any decoder triangles sharing this edge.
   controls.forEach((p,i)=>pin(p,baseX,(indices.length?dataTop:height)*(i+1)/(controls.length+1)));
 }
 return out+"</g>";
}
function recordSvg(b:Block,pal:Palette):string {
 const fs=b.recordFields!,title=b.label.split("\n"),colWidths=fs.map(f=>Math.max(86,textWidth(`${f.label} [${f.width}]`)+16,textWidth(`[${f.msb}:${f.lsb}]`)+16,textWidth(f.use??"")+16)),width=colWidths.reduce((a,x)=>a+x,0),top=title.length*16+20,height=top+49+18;let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${width}" s:height="${height}" id="cell_${esc(b.id)}"><s:alias val="CDL__${esc(b.id)}"/>`;
 out+=tag("rect",{x:0,y:0,width,height,fill:pal.neutral,stroke:pal.ink,"stroke-width":1.5,class:"symbol $cell_id"});title.forEach((s,i)=>out+=tag("text",{x:width/2,y:14+i*16,"text-anchor":"middle","font-size":13,"font-weight":"bold",fill:pal.ink},s));let x=0;fs.forEach((f,i)=>{const fw=colWidths[i],cx=x+fw/2;if(i)out+=tag("line",{x1:x,y1:top,x2:x,y2:height,stroke:pal.ink});out+=tag("text",{x:cx,y:top+13,"text-anchor":"middle","font-size":10,fill:pal.ink},`${f.label} [${f.width}]`);out+=tag("text",{x:cx,y:top+27,"text-anchor":"middle","font-size":9,fill:pal.ink},`[${f.msb}:${f.lsb}]`);if(f.use)out+=tag("text",{x:cx,y:top+40,"text-anchor":"middle","font-size":8,fill:pal.ink},f.use);out+=`<g s:x="${cx}" s:y="${height}" s:pid="${esc(f.id)}"/>`;x+=fw;});
 out+=`<g s:x="${width/2}" s:y="0" s:pid="IN"/></g>`;return out;
}
function blockSvg(b:Block,pal:Palette,direction:Flow,order?:ReadonlyMap<string,number>):string{
 if(b.structuredTable)return structuredTableSvg(b,pal);
 if(b.recordFields)return recordSvg(b,pal);
 if(b.table)return tableSvg(b,pal);
 const sides:Record<Side,Port[]>={west:[],east:[],north:[],south:[]};for(const p of Object.values(b.ports))sides[p.side??(p.direction==="input"?"west":"east")].push(p);
 for(const side of facing)sides[side]=orderedSlots(sides[side],order);
 const flow=b.explicitRotation||b.rotation?rotationFlow[b.rotation/90]
   :b.builtin&&autoOriented.has(b.type)&&!Object.values(b.ports).some(p=>p.explicitSide)?direction:"LR";
 if(b.type==="MUX")return muxSvg(b,pal,sides,flow);
 const labelLines=b.label.split("\n"),len=(s:Port[])=>s.reduce((n,p)=>Math.max(n,p.name.length),0),maxSide=Math.max(sides.west.length,sides.east.length);
 const logicGate=["AND","OR","NOT"].includes(b.type);
 const orInset=10;
 let w:number,h:number;if(logicGate){w=80;h=Math.max(60,Math.ceil((20*maxSide+14)/10)*10);}
 else if(compact.has(b.type)){w=Math.max(66,42+b.label.length*7.5,30+13*Math.max(sides.north.length,sides.south.length));h=Math.max(50,19*maxSide+14);}
 else if(b.type==="DEMUX"){w=trapInset;h=Math.ceil(Math.max(78,24*maxSide+30)/10)*10;}
 else if(b.type==="ALU"){w=Math.max(110,40+b.label.length*8);h=Math.max(100,32*maxSide+40);}
 else {
   w=Math.max(108,18+Math.max(...labelLines.map(x=>x.length))*7.5,42+(len(sides.west)+len(sides.east))*7.2,54+25*Math.max(sides.north.length,sides.south.length),...(["north","south"] as const).map(side=>(sides[side].length+1)*(len(sides[side])*6.2+10)));
   h=Math.max(70,54+24*maxSide,sides.north.length&&sides.south.length?100:70);
   if(flow==="TB"||flow==="BT")h=Math.max(h,24+Math.max(...labelLines.map(x=>x.length))*7.5,36*maxSide+30,42+(len(sides.north)+len(sides.south))*7.2);
   if(b.type==="FIFO")w=Math.max(w,150);
 }
 const roundedBox=compact.has(b.type)&&!logicGate;
 const step=roundedBox?10:1;
 w=Math.ceil(w/step)*step;h=Math.ceil(h/step)*step;const ink=pal.ink,fill=pal[defaultStyle(b) as keyof Palette]??pal.neutral,base={stroke:ink,"stroke-width":1.6,fill,class:"symbol $cell_id"};let shape="";
 if(b.type==="DEMUX")shape=tag("path",{...base,d:`M 0,${trapInset} L ${w},0 L ${w},${h} L 0,${h-trapInset} Z`});
 else if(b.type==="ALU")shape=tag("path",{...base,d:`M 0,0 L ${w},${(.22*h).toFixed(2)} L ${w},${(.78*h).toFixed(2)} L 0,${h} L 0,${(.65*h).toFixed(2)} L ${(.18*w).toFixed(2)},${(.5*h).toFixed(2)} L 0,${(.35*h).toFixed(2)} Z`});
 else if(b.type==="AND"){
   // Two cubic quarter-ellipses keep the tip on the output under nonuniform resizing.
   const arcStart=.48*w, half=h/2, k=4/3*Math.tan(Math.PI/8);
   const controlX=(arcStart+k*(w-arcStart)).toFixed(4), controlY=k*half;
   const d=[
     `M 0,0 L ${arcStart},0`,
     `C ${controlX},0 ${w},${(half-controlY).toFixed(4)} ${w},${half}`,
     `C ${w},${(half+controlY).toFixed(4)} ${controlX},${h} ${arcStart},${h}`,
     `L 0,${h} Z`,
   ].join(" ");
   shape=tag("path",{...base,d});
 }
 else if(b.type==="OR"){
   // The quadratic at one-third and two-thirds of its height reaches the input anchors.
   shape=tag("path",{...base,d:`M 0,0 Q ${(w*.56).toFixed(2)},0 ${w},${h/2} Q ${(w*.56).toFixed(2)},${h} 0,${h} Q ${orInset*9/4},${h/2} 0,0 Z`});
 }
 else if(b.type==="NOT"){shape=tag("path",{...base,d:`M 0,0 L ${(w-8).toFixed(2)},${(h/2).toFixed(2)} L 0,${h} Z`})+tag("circle",{cx:w-4,cy:h/2,r:4,stroke:ink,"stroke-width":1.6,fill});}
 else if(compact.has(b.type))shape=tag("rect",{...base,x:0,y:0,width:w,height:h,rx:9,ry:9});
 else {shape=tag("rect",{...base,x:0,y:0,width:w,height:h,rx:b.type==="box"?4:3});if(b.type==="FIFO"){const x0=44,x1=w-44,y0=h/2-12,n=5,cw=(x1-x0)/n;shape+=tag("rect",{x:x0,y:y0,width:x1-x0,height:24,stroke:ink,"stroke-width":1.2,fill:pal.paper});for(let i=1;i<n;i++)shape+=tag("line",{x1:x0+cw*i,y1:y0,x2:x0+cw*i,y2:y0+24,stroke:ink,"stroke-width":1.2});shape+=tag("path",{d:`M ${x1+4},${h/2} l -8,-4 0,8 Z`,fill:ink,stroke:"none"});}
 if(b.type==="DFF"||b.type==="FIFO"){const p=b.ports.CLK,side=p?.side??"west";const d=side==="west"?`M 0,${h-16} l 9,6 -9,6`:side==="south"?`M ${w/2-6},${h} l 6,-9 6,9`:side==="north"?`M ${w/2-6},0 l 6,9 6,-9`:`M ${w},${h-16} l -9,6 9,6`;shape+=tag("path",{d,stroke:ink,"stroke-width":1.8,fill:"none"});}}
 const operators:Record<string,string>={ADD:"+",SUB:"−",CMP:b.params.op==="ne"?"≠":"="};
 const title=b.type==="DEMUX"?"":b.type==="FIFO"&&b.label==="FIFO"?`FIFO (${b.params.depth??8})`:b.label==="box"?b.id:b.label===b.type?(operators[b.type]??(logicGate?"":b.label)):b.label;
 const centered=compact.has(b.type)||b.type==="ALU";
 const frame=drawingFrame(flow,w,h,b.flipX,b.flipY);
 const [titleX,titleY]=centered?frame.point(b.type==="ALU"?w*.6:w/2,h/2)
   :[frame.width/2,frame.turned&&facing.some(side=>sides[side].length&&frame.side(side)==="north")?36:17];
 const fs=operators[b.type]?24:b.type==="ALU"?13:compact.has(b.type)?11:13;
 let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${frame.width}" s:height="${frame.height}" id="cell_${esc(b.id)}"><s:alias val="CDL__${esc(b.id)}"/>${frame.outline(shape)}${title?tag("text",{x:titleX.toFixed(2),y:(titleY+4).toFixed(2),"text-anchor":"middle","font-size":fs,"font-weight":"bold",fill:ink,stroke:"none"},title):""}`;
 for(const side of ["west","east","north","south"] as const){const ps=sides[side];ps.forEach((p,order)=>{
   const i=frame.index(side,order,ps.length);
   let x:number,y:number,tx:number,ty:number,anchor:string;
   const spacing=(side==="west"||side==="east"?h:w)/(ps.length+1);
   const slot=compact.has(b.type)||b.type==="DEMUX"?gridSlot(spacing*(i+1),spacing):spacing*(i+1);
   if(side==="west"||side==="east"){
     y=b.type==="ALU"&&side==="west"&&ps.length===2?h*(i===0?.23:.77)
       :b.type==="DEMUX"&&side==="west"?trapInset+(h-2*trapInset)*(i+.5)/ps.length:slot;
     const f=y/h;
     x=b.type==="ALU"&&side==="west"?w*.18*Math.max(0,1-Math.abs(f-.5)/.15)
       :b.type==="OR"&&side==="west"?orInset*4.5*f*(1-f):side==="west"?0:w;
     tx=x+(side==="west"?12:-12);ty=y+3;anchor=side==="west"?"start":"end";
   }
   else{
     x=slot;
     const inset=b.type==="ALU"?.22*h*x/w:b.type==="DEMUX"?trapInset*(1-x/w):0;
     y=side==="north"?inset:h-inset;tx=x;ty=y+(side==="north"?(centered?17:39):centered?-12:-16);anchor="middle";
   }
   const label=logicGate||b.type==="CMP"||b.type==="DEMUX"?"":p.name;
   const edge=frame.side(side);
   if(frame.turned){
     [x,y]=frame.point(x,y);
     tx=x+(edge==="west"?12:edge==="east"?-12:0);
     ty=y+(edge==="north"?17:edge==="south"?-12:3);
     anchor=edge==="west"?"start":edge==="east"?"end":"middle";
   }
   // Leave the inversion bubble clear of the outgoing arrow.
   out+=markedPin(p,edge,x,y,ink,b.type==="NOT"&&p.direction==="output"&&side==="east"?10:0);
   if(label)out+=tag("text",{x:tx.toFixed(2),y:ty.toFixed(2),"text-anchor":anchor,"font-size":compact.has(b.type)?9:10,fill:ink,stroke:"none"},label);
  });}
 return out+"</g>";
}

function interfaceSvg(type:string,alias:string,side:Side,pin:string,label?:string):string{
 const s=interfaceShape[side];
 const name=label===undefined
   ?tag("text",{x:s.labelX,y:s.labelY,class:"nodelabel $cell_id","s:attribute":"ref"},type)
   :tag("text",{x:s.labelX,y:s.labelY,class:"nodelabel"},label);
 return `<g s:type="${type}" transform="translate(0,0)" s:width="${s.width}" s:height="${s.height}">${tag("s:alias",{val:alias})}${name}${tag("path",{d:s.path,class:"symbol $cell_id"})}${tag("g",{"s:x":s.x,"s:y":s.y,"s:pid":pin})}</g>`;
}

export function layoutOptions(d:Diagram,layout=d.layout):Record<string,string>{
 const preset=PRESETS[layout];
 const options:Record<string,string>={
   "org.eclipse.elk.direction":layoutDirection[d.direction],
   "org.eclipse.elk.edgeRouting":"ORTHOGONAL",
   "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers":String(preset.layers),
   "org.eclipse.elk.spacing.nodeNode":String(preset.nodes),
   "org.eclipse.elk.spacing.edgeNode":String(preset.edge),
   "org.eclipse.elk.layered.cycleBreaking.strategy":"GREEDY",
   "org.eclipse.elk.layered.layering.strategy":"LONGEST_PATH",
 };
 if(Object.values(d.blocks).some(b=>b.rank!=null)) options["org.eclipse.elk.partitioning.activate"]="true";
 if(d.mode==="microarchitecture"||(d.direction!=="LR"&&Object.keys(d.ports).length)){
   const margin=Math.ceil(Math.max(42,...Object.keys(d.ports).map(textWidth))+18);
   options["org.eclipse.elk.padding"]=`top=36,left=${margin},bottom=36,right=${margin}`;
 }
 return options;
}

/** Generate the Netlist2SVG skin paired with yosysJson(diagram, true). */
export function generateSkin(d:Diagram,theme=d.theme,layout=d.layout,orders?:PinOrders,
 adapters=d.direction==="LR"?[]:compileNetlist(d,true).adapters):string{
 const pal=PALETTES[theme];
 const css=`svg { stroke: ${pal.wire}; fill: none; } text { fill: ${pal.ink}; stroke: none; font-family: sans-serif; font-size: 10px; } .nodelabel { text-anchor: middle; } .inputPortLabel { text-anchor: end; } .symbol { stroke: ${pal.ink}; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; } .splitjoinBody,.junction { fill: ${pal.ink}; } .labelBackground { fill: ${pal.paper}; stroke:none; } .detail { fill:${pal.ink}; } line { stroke: ${pal.wire}; } .cdiag-net-label { font-family: sans-serif; font-size: 10px; fill: ${pal.ink}; } .cdiag-net-label-bg { fill:${pal.paper}; stroke:none; }`;
 const props=`<s:properties${d.direction==="LR"?"":' splitsAndJoins="false"'}>${tag("s:layoutEngine",layoutOptions(d,layout))}</s:properties>`;
 let essentials=(["input","output"] as const).map(direction=>{
   const kind=direction==="input"?"inputExt":"outputExt";
   const side=defaultInterfaceSide(d.direction,direction);
   return interfaceSvg(kind,`$_${kind}_`,side,interfacePin(direction));
 }).join("");
 essentials+='<g s:type="constant" transform="translate(0,0)" s:width="30" s:height="20"><s:alias val="$_constant_"/><text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">constant</text><rect width="30" height="20" class="symbol $cell_id"/><g s:x="30" s:y="10" s:pid="Y"/></g>';
 if(hasPlacedPorts(d))for(const port of Object.values(d.ports)){
   essentials+=interfaceSvg(`cdiag_port_${port.name}`,interfaceAlias(port.name),interfaceSide(d,port),interfacePin(port.direction),port.name);
 }
 for(const k of ["split","join"]){const pin=k==="split"?"out":"in",x=k==="split"?5:0;essentials+=`<g s:type="${k}" transform="translate(0,0)" s:width="5" s:height="40"><s:alias val="$_${k}_"/><rect width="5" height="40" s:generic="body" class="splitjoinBody"/><g s:x="${k==="split"?0:5}" s:y="20" s:pid="${k==="split"?"in":"out"}"/>${[10,30].map((y,i)=>`<g transform="translate(${x},${y})" s:x="${x}" s:y="${y}" s:pid="${pin}${i}"><text x="${k==="split"?5:-3}" y="-4" class="${k==="join"?"inputPortLabel":""}">hi:lo</text></g>`).join("")}</g>`;}
 const generic='<g s:type="generic" transform="translate(0,0)" s:width="60" s:height="50"><text x="30" y="-4" class="nodelabel $cell_id" s:attribute="ref">generic</text><rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>'+[[0,12,"in0"],[0,38,"in1"],[60,12,"out0"],[60,38,"out1"]].map(([x,y,p])=>`<g transform="translate(${x},${y})" s:x="${x}" s:y="${y}" s:pid="${p}"><text x="${x===0?-3:5}" y="-4" class="${x===0?"inputPortLabel":""}">${p}</text></g>`).join("")+'</g>';
 essentials+=generic+generic.replace('s:type="generic"','s:type="sub_odd"').replace('<rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>','<rect width="60" height="50" fill="'+pal.neutral+'" s:generic="body" class="symbol $cell_id"/>')+generic.replace('s:type="generic"','s:type="sub_even"').replace('<rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>','<rect width="60" height="50" fill="'+pal.neutral+'" s:generic="body" class="symbol $cell_id"/>');
 const buses=adapters.map(adapter=>busAdapterSvg(adapter,pal,d.direction)).join("");
 return `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="${SVG_NS}" xmlns:s="${SKIN_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="500"><style>${esc(css)}</style>${props}${essentials}${buses}${Object.values(d.blocks).map(b=>blockSvg(b,pal,d.direction,orders?.get(b.id))).join("")}</svg>\n`;
}
