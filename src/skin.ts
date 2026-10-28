import type { Block, Diagram, Port, Side } from "./model.js";
import { defaultStyle } from "./symbols.js";

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
const compact=new Set(["ADD","SUB","SHIFT","SHL","SHR","SAR","CMP","AND","OR","XOR","NOT"]);
function blockSvg(b:Block,pal:Palette):string{
 const sides:Record<Side,Port[]>={west:[],east:[],north:[],south:[]};for(const p of Object.values(b.ports))sides[p.side??(p.direction==="input"?"west":"east")].push(p);
 const labelLines=b.label.split("\n"),len=(s:Port[])=>s.reduce((n,p)=>Math.max(n,p.name.length),0),maxSide=Math.max(sides.west.length,sides.east.length);
 let w:number,h:number;if(compact.has(b.type)){w=Math.max(66,42+b.label.length*7.5,30+13*Math.max(sides.north.length,sides.south.length));h=Math.max(50,19*maxSide+14);}
 else if(b.type==="MUX"){w=Math.max(67,32+b.label.length*7);h=Math.max(78,24*maxSide+30);}
 else if(b.type==="ALU"){w=Math.max(110,40+b.label.length*8);h=Math.max(100,32*maxSide+40);}
 else {w=Math.max(108,18+Math.max(...labelLines.map(x=>x.length))*7.5,42+(len(sides.west)+len(sides.east))*7.2,54+25*Math.max(sides.north.length,sides.south.length));h=Math.max(70,54+24*maxSide,sides.north.length&&sides.south.length?100:70);}
 w=Math.ceil(w);h=Math.ceil(h);const ink=pal.ink,fill=pal[defaultStyle(b) as keyof Palette]??pal.neutral,base={stroke:ink,"stroke-width":1.6,fill,class:"symbol $cell_id"};let shape="";
 if(b.type==="MUX"){const n=.23*h;shape=tag("path",{...base,d:`M 0,0 L ${w},${((h-n)/2).toFixed(2)} L ${w},${((h+n)/2).toFixed(2)} L 0,${h} Z`});}
 else if(b.type==="ALU")shape=tag("path",{...base,d:`M 0,0 L ${w},${(.22*h).toFixed(2)} L ${w},${(.78*h).toFixed(2)} L 0,${h} L 0,${(.65*h).toFixed(2)} L ${(.18*w).toFixed(2)},${(.5*h).toFixed(2)} L 0,${(.35*h).toFixed(2)} Z`});
 else if(compact.has(b.type))shape=tag("rect",{...base,x:0,y:0,width:w,height:h,rx:9,ry:9});
 else {shape=tag("rect",{...base,x:0,y:0,width:w,height:h,rx:b.type==="box"?4:3});if(b.type==="DFF"){const p=b.ports.CLK,side=p?.side??"west";const d=side==="west"?`M 0,${h-16} l 9,6 -9,6`:side==="south"?`M ${w/2-6},${h} l 6,-9 6,9`:side==="north"?`M ${w/2-6},0 l 6,9 6,-9`:`M ${w},${h-16} l -9,6 9,6`;shape+=tag("path",{d,stroke:ink,"stroke-width":1.8,fill:"none"});}}
 const title=b.label==="box"?b.id:b.label,tx=b.type==="MUX"?w*.48:b.type==="ALU"?w*.6:w/2,ty=compact.has(b.type)||b.type==="MUX"||b.type==="ALU"?h/2+4:21,fs=b.type==="ALU"?13:compact.has(b.type)||b.type==="MUX"?11:13;
 let out=`<g s:type="cdiag_${esc(b.id)}" transform="translate(30,20)" s:width="${w}" s:height="${h}"><s:alias val="CDL__${esc(b.id)}"/>${shape}${tag("text",{x:tx.toFixed(2),y:ty.toFixed(2),"text-anchor":"middle","font-size":fs,"font-weight":"bold",fill:ink,stroke:"none"},title)}`;
 for(const side of ["west","east","north","south"] as Side[]){const ps=sides[side];ps.forEach((p,i)=>{let x:number,y:number,tx:number,ty:number,anchor:string;
   if(side==="west"||side==="east"){y=b.type==="ALU"&&side==="west"&&ps.length===2?h*(i===0?.23:.77):h*(i+1)/(ps.length+1);x=b.type==="ALU"&&side==="west"?w*.18*Math.max(0,1-Math.abs(y-h*.5)/(h*.15)):side==="west"?0:w;if(b.type==="MUX"&&side==="east")y=h*.5;tx=x+(side==="west"?7:-7);ty=y-4;anchor=side==="west"?"start":"end";}
   else{x=w*(i+1)/(ps.length+1);y=b.type==="MUX"?h*(side==="north"?.385*x/w:1-.385*x/w):b.type==="ALU"?h*(side==="north"?.22*x/w:1-.22*x/w):side==="north"?0:h;tx=x;ty=y+(side==="north"?(compact.has(b.type)||b.type==="MUX"||b.type==="ALU"?13:35):(compact.has(b.type)?-6:b.type==="MUX"||b.type==="ALU"?-8:h-12));anchor="middle";}
   out+=`<g s:x="${x.toFixed(2)}" s:y="${y.toFixed(2)}" s:pid="${esc(p.name)}"/><text x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" text-anchor="${anchor}" font-size="${compact.has(b.type)?9:10}" fill="${ink}" stroke="none">${esc(p.name)}</text>`;
  });}
 return out+"</g>";
}

/** Generate the Netlist2SVG skin paired with yosysJson(diagram, true). */
export function generateSkin(d:Diagram,theme=d.theme,layout=d.layout):string{
 const pal=PALETTES[theme],preset=PRESETS[layout];
 const css=`svg { stroke: ${pal.wire}; fill: none; } text { fill: ${pal.ink}; stroke: none; font-family: sans-serif; font-size: 10px; } .nodelabel { text-anchor: middle; } .inputPortLabel { text-anchor: end; } .symbol { stroke: ${pal.ink}; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; } .splitjoinBody,.junction { fill: ${pal.ink}; } .labelBackground { fill: ${pal.paper}; stroke:none; } .detail { fill:${pal.ink}; } line { stroke: ${pal.wire}; } .cdiag-net-label { font-family: sans-serif; font-size: 10px; fill: ${pal.ink}; } .cdiag-net-label-bg { fill:${pal.paper}; stroke:none; }`;
 const direction={LR:"RIGHT",RL:"LEFT",TB:"DOWN",BT:"UP"}[d.direction];
 const props=`<s:properties><s:layoutEngine org.eclipse.elk.direction="${direction}" org.eclipse.elk.edgeRouting="ORTHOGONAL" org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers="${preset.layers}" org.eclipse.elk.spacing.nodeNode="${preset.nodes}" org.eclipse.elk.spacing.edgeNode="${preset.edge}" org.eclipse.elk.layered.cycleBreaking.strategy="GREEDY" org.eclipse.elk.layered.layering.strategy="LONGEST_PATH"/></s:properties>`;
 let essentials="";for(const k of ["inputExt","outputExt","constant"]){const shape=k==="inputExt"?'<path d="M0,0 L0,20 L15,20 L30,10 L15,0 Z" class="symbol $cell_id"/>':k==="outputExt"?'<path d="M30,0 L30,20 L15,20 L0,10 L15,0 Z" class="symbol $cell_id"/>':'<rect width="30" height="20" class="symbol $cell_id"/>';essentials+=`<g s:type="${k}" transform="translate(0,0)" s:width="30" s:height="20"><s:alias val="$_${k}_"/><text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">${k}</text>${shape}<g s:x="${k==="outputExt"?0:30}" s:y="10" s:pid="${k==="outputExt"?"A":"Y"}"/></g>`;}
 for(const k of ["split","join"]){const pin=k==="split"?"out":"in",x=k==="split"?5:0;essentials+=`<g s:type="${k}" transform="translate(0,0)" s:width="5" s:height="40"><s:alias val="$_${k}_"/><rect width="5" height="40" s:generic="body" class="splitjoinBody"/><g s:x="${k==="split"?0:5}" s:y="20" s:pid="${k==="split"?"in":"out"}"/>${[10,30].map((y,i)=>`<g transform="translate(${x},${y})" s:x="${x}" s:y="${y}" s:pid="${pin}${i}"><text x="${k==="split"?5:-3}" y="-4" class="${k==="join"?"inputPortLabel":""}">hi:lo</text></g>`).join("")}</g>`;}
 const generic='<g s:type="generic" transform="translate(0,0)" s:width="60" s:height="50"><text x="30" y="-4" class="nodelabel $cell_id" s:attribute="ref">generic</text><rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>'+[[0,12,"in0"],[0,38,"in1"],[60,12,"out0"],[60,38,"out1"]].map(([x,y,p])=>`<g transform="translate(${x},${y})" s:x="${x}" s:y="${y}" s:pid="${p}"><text x="${x===0?-3:5}" y="-4" class="${x===0?"inputPortLabel":""}">${p}</text></g>`).join("")+'</g>';
 essentials+=generic+generic.replace('s:type="generic"','s:type="sub_odd"').replace('<rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>','<rect width="60" height="50" fill="'+pal.neutral+'" s:generic="body" class="symbol $cell_id"/>')+generic.replace('s:type="generic"','s:type="sub_even"').replace('<rect width="60" height="50" s:generic="body" class="symbol $cell_id"/>','<rect width="60" height="50" fill="'+pal.neutral+'" s:generic="body" class="symbol $cell_id"/>');
 return `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="${SVG_NS}" xmlns:s="${SKIN_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="500"><style>${esc(css)}</style>${props}${essentials}${Object.values(d.blocks).map(b=>blockSvg(b,pal)).join("")}</svg>\n`;
}
