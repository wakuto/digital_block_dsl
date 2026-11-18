import { deflateRawSync } from "node:zlib";
import type { PALETTES } from "./skin.js";

export type SvgNode = [string, Record<string,string>, ...(SvgNode|string)[]];
export type Palette = typeof PALETTES.light;
export type Point = { x:number; y:number };
type Matrix = [number,number,number,number,number,number];
const identity:Matrix = [1,0,0,1,0,0];
export const children = (node:SvgNode) => node.slice(2).filter(Array.isArray) as SvgNode[];
export const xml = (value:unknown) => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;")
  .replaceAll("\r","&#13;").replaceAll("\n","&#10;").replaceAll("\t","&#9;");
export const number = (n:number) => Math.round(n*10000)/10000;
export function element(name:string, attrs:Record<string,unknown>={}, body?:string):string {
  const attr=Object.entries(attrs).map(([k,v])=>" "+k+'="'+xml(v)+'"').join("");
  return "<"+name+attr+(body===undefined?"/>":">"+body+"</"+name+">");
}
export const geometry=(attrs:Record<string,unknown>,body?:string)=>element("mxGeometry",{...attrs,as:"geometry"},body);

const nums = (value:string) => (value.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gi)??[]).map(Number);
function transform(parent:Matrix, value?:string):Matrix {
  if(!value)return parent;
  const [a,b,c,d,x,y]=parent;
  const raw=nums(value);
  const [p,q,r,s,u,v]=value.startsWith("matrix(")?raw:[1,0,0,1,raw[0]??0,raw[1]??0];
  if(!/^(translate|matrix)\(/.test(value))throw new Error("Unsupported draw.io symbol transform: "+value);
  return [a*p+c*q,b*p+d*q,a*r+c*s,b*r+d*s,a*u+c*v+x,b*u+d*v+y];
}
function point(m:Matrix,x:number,y:number):Point {
  return {x:number(m[0]*x+m[2]*y+m[4]),y:number(m[1]*x+m[3]*y+m[5])};
}
function bounds(m:Matrix,x:number,y:number,w:number,h:number){
  // The renderer only translates or turns symbols in quarter turns.
  const a=point(m,x,y), b=point(m,x+w,y+h);
  return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:number(Math.abs(b.x-a.x)),h:number(Math.abs(b.y-a.y))};
}
function path(d:string,m:Matrix):string {
  const tokens=d.match(/[a-z]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gi)??[];
  let i=0,x=0,y=0,command="";
  const parts:string[]=[];
  const take=()=>Number(tokens[i++]);
  while(i<tokens.length){
    if(/^[a-z]$/i.test(tokens[i]))command=tokens[i++];
    switch(command){
      case "M":
      case "L":
      case "l": {
        const px=take(), py=take(), move=command==="M";
        if(command==="l"){x+=px;y+=py;}else{x=px;y=py;}
        parts.push(element(move?"move":"line",point(m,x,y)));
        if(move)command="L";
        break;
      }
      case "Q": {
        const a=point(m,take(),take()), end=point(m,x=take(),y=take());
        parts.push(element("quad",{x1:a.x,y1:a.y,x2:end.x,y2:end.y}));
        break;
      }
      case "C": {
        const a=point(m,take(),take()), b=point(m,take(),take()), end=point(m,x=take(),y=take());
        parts.push(element("curve",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,x3:end.x,y3:end.y}));
        break;
      }
      case "Z": case "z":
        parts.push("<close/>");
        command="";
        break;
      default: throw new Error("Unsupported draw.io symbol path command: "+command);
    }
  }
  return element("path",{},parts.join(""));
}

export interface ShapeLabel extends Point { text:string; size:number; align:"left"|"center"|"right"; bold:boolean; color:string }
/** Position relative to the editable shape's bounds. */
export interface Constraint extends Point { name:string }
export function editableShape(node:SvgNode,w:number,h:number,pal:Palette,pins:Constraint[]){
  const shapes:string[]=[];
  const labels:ShapeLabel[]=[];
  const anchors=new Map(children(node).filter(([,a])=>a["s:pid"]).map(([,a])=>[a["s:pid"],a]));
  const pinByName=new Map(pins.map(pin=>[pin.name,pin]));
  function visit(child:SvgNode,parent:Matrix){
    const [name,a]=child,m=transform(parent,a.transform);
    const css=(a.class??"").split(/\s+/);
    const attr=(key:string)=>Number(a[key]??0);
    if(name==="g"){for(const item of children(child))visit(item,m);return;}
    if(name==="text"){
      const text=child.slice(2).filter(v=>typeof v==="string").join("");
      if(!text)return;
      const anchor=a["text-anchor"]??(css.includes("nodelabel")?"middle":css.includes("inputPortLabel")?"end":"start");
      labels.push({...point(m,attr("x"),attr("y")),text,size:Number(a["font-size"]??10),
        align:anchor==="middle"?"center":anchor==="end"?"right":"left",bold:a["font-weight"]==="bold",color:a.fill??pal.ink});
      return;
    }
    let geometry:string;
    if(name==="rect"){
      const b=bounds(m,attr("x"),attr("y"),attr("width"),attr("height"));
      geometry=a.rx?element("roundrect",{...b,arcsize:Math.min(100,200*attr("rx")/Math.min(b.w,b.h))}):element("rect",b);
    }else if(name==="circle"){
      const r=attr("r");
      geometry=element("ellipse",bounds(m,attr("cx")-r,attr("cy")-r,2*r,2*r));
    }else if(name==="line"){
      geometry=element("path",{},element("move",point(m,attr("x1"),attr("y1")))+element("line",point(m,attr("x2"),attr("y2"))));
    }else if(name==="path"){
      // Keep the visible arrow on the same anchor as the rounded connection point.
      const pin=pinByName.get(a["data-port"]), anchor=anchors.get(a["data-port"]);
      const matrix:Matrix=pin&&anchor
        ?[m[0],m[1],m[2],m[3],m[4]+pin.x*w-Number(anchor["s:x"]),m[5]+pin.y*h-Number(anchor["s:y"])]
        :m;
      geometry=path(a.d,matrix);
    }else return; // e.g. the skin alias
    const symbol=css.includes("symbol");
    const fill=name==="line"?"none":a.fill??(css.includes("splitjoinBody")?pal.ink:"none");
    const stroke=a.stroke??(symbol?pal.ink:pal.wire);
    const color=(kind:string,value:string)=>element(kind+"color",{color:value});
    shapes.push(color("fill",fill)+color("stroke",stroke)+
      element("strokewidth",{width:symbol?1.5:Number(a["stroke-width"]??1),fixed:1})+
      geometry+(fill!=="none"?(stroke!=="none"?"<fillstroke/>":"<fill/>"):stroke!=="none"?"<stroke/>":""));
  }
  for(const child of children(node))visit(child,identity);
  const connections=element("connections",{},pins.map(pin=>element("constraint",{
    x:pin.x,y:pin.y,perimeter:0,name:pin.name
  })).join(""));
  const shape=element("shape",{name:"CDL symbol",w,h,aspect:"variable",strokewidth:"inherit"},
    connections+"<background/>"+element("foreground",{},"<linecap cap=\"round\"/><linejoin join=\"round\"/>"+shapes.join("")));
  const stencil=deflateRawSync(encodeURIComponent(shape)).toString("base64");
  return {style:"shape=stencil("+stencil+");perimeter=none;",labels};
}
