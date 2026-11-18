import { createRequire } from "node:module";
import type { Diagram } from "./model.js";
import type { NetlistGraph } from "./port-layout.js";
import { children, editableShape, element, geometry, number, xml, type Palette, type Point, type ShapeLabel, type SvgNode } from "./drawio-shapes.js";
import { planTable } from "./drawio-tables.js";
import { branchWires, edgePoints, position as pos, simplifyWire, snapWireTracks,
  type RoutedWire, type WireEnd } from "./drawio-routes.js";
import { textWidth } from "./table.js";

const require = createRequire(import.meta.url);
const { parse } = require("onml") as { parse(svg:string):SvgNode };
const gridSize=10;
const snap=(n:number,step=gridSize)=>Math.round(n/step)*step;

function snapSize(size:number):number {
  const whole=Math.max(gridSize,snap(size));
  // A half-step keeps narrow symbols from growing or shrinking disproportionately.
  const step=gridSize/2;
  return Math.abs(whole-size)<=size*0.1?whole:Math.max(step,snap(size,step));
}

function snapPort(x:number,y:number,scale:Point):Point {
  return {x:Math.round(number(x*scale.x)),y:Math.round(number(y*scale.y))};
}

interface Vertex {
  id:string;
  x:number;
  y:number;
  w:number;
  h:number;
  bounds:Point & {width:number;height:number};
  scale:Point;
  svg:SvgNode;
  pins:Map<string,Point>;
  table?:ReturnType<typeof planTable>;
}

function textCell(label:ShapeLabel,id:string,parent:string,scale:Point) {
  const height=label.size+4, width=number(Math.max(8,textWidth(label.text)*label.size/10));
  const x=number(label.x*scale.x-width*(label.align==="center"?0.5:label.align==="right"?1:0));
  const y=number(label.y*scale.y-label.size*0.9);
  const style="text;html=0;strokeColor=none;fillColor=none;whiteSpace=nowrap;spacing=0;verticalAlign=middle;"
    +"fontFamily=Helvetica;fontSize="+label.size+";fontStyle="+(label.bold?1:0)+";fontColor="+label.color+";align="+label.align+";";
  return element("mxCell",{id,value:label.text,style,vertex:1,parent,connectable:0},
    geometry({x,y,width,height}));
}

/** Short orthogonal transitions connect moved terminals to existing wire tracks. */
function jog(a:Point,b:Point,vertical:boolean):Point[] {
  if(a.x===b.x||a.y===b.y)return [];
  const axis=vertical?"y":"x";
  const midpoint=(a[axis]+b[axis])/2;
  const onGrid=snap(midpoint);
  const middle=onGrid>Math.min(a[axis],b[axis])+1&&onGrid<Math.max(a[axis],b[axis])-1
    ?onGrid:number(midpoint);
  return [{...a,[axis]:middle},{...b,[axis]:middle}];
}

function reconnect(points:Point[],start:Point,end:Point):Point[] {
  if(points.length<2)return [start,...jog(start,end,true),end];
  const a=points[0],b=points[points.length-1];
  const first=a.x===points[1].x;
  const last=b.x===points[points.length-2].x;
  const bends=points.slice(1,-1);
  if(!bends.length)return [start,...jog(start,end,first),end];
  const across=first?"x":"y", finalAcross=last?"x":"y";
  bends[0]={...bends[0],[across]:start[across]};
  bends[bends.length-1]={...bends[bends.length-1],[finalAcross]:end[finalAcross]};
  return [start,...bends,end];
}

/** Add the editable model to the same SVG that ordinary viewers display. */
export function embedDrawio(svg:string,layout:NetlistGraph,diagram:Diagram,palette:Palette,widthLabels:Set<string>):string {
  const root=parse(svg);
  if(root[0]!=="svg")throw new Error("Expected an SVG from Netlist2SVG");
  const nodes=new Map((layout.children??[]).map(node=>[node.id,node]));
  const vertices=new Map<string,Vertex>();
  for(const symbol of children(root)){
    const name=symbol[1].id;
    if(symbol[0]!=="g"||!name?.startsWith("cell_"))continue;
    const key=name.slice(5), nodeId=layout.id+"."+key, node=nodes.get(nodeId);
    if(!node)throw new Error("Missing layout for "+name);
    const x=node.x??0,y=node.y??0,w=Math.max(1,node.width??1),h=Math.max(1,node.height??1);
    const bounds={x:snap(x),y:snap(y),width:snapSize(w),height:snapSize(h)};
    const scale={x:bounds.width/w,y:bounds.height/h};
    const block=diagram.blocks[key];
    const table=block&&(block.structuredTable||block.table||block.recordFields)
      ?planTable(block,symbol,{x:w,y:h},scale):undefined;
    const pins=new Map<string,Point>();
    for(const port of node.ports??[]){
      if(port.x===undefined||port.y===undefined)continue;
      const name=port.id.slice(nodeId.length+1);
      const x=port.x+(port.width??0)/2, y=port.y+(port.height??0)/2;
      const pin=table?.project({x,y})??snapPort(x,y,scale);
      pins.set(name,pin);
    }
    vertices.set(nodeId,{id:"v"+vertices.size,x,y,w,h,bounds,scale,svg:symbol,pins,table});
  }

  const edges:string[]=[], junctions:string[]=[];
  const routes=layout.edges.map(edgePoints);
  const onGrid=snapWireTracks(routes,[...vertices.values()].map(node=>node.bounds));
  function attach(vertex:Vertex|undefined,at:Point,name:string|undefined):WireEnd {
    if(!vertex)return {point:onGrid(at)};
    const pinName=name?.slice(name.lastIndexOf(".")+1);
    const local={x:at.x-vertex.x,y:at.y-vertex.y};
    const decoder=pinName?vertex.table?.decoders.get(pinName):undefined;
    const {x,y}=decoder?.apex??vertex.table?.project(local)??snapPort(local.x,local.y,vertex.scale);
    // Use the routed anchor when ELK places it off the port's center.
    if(pinName)vertex.pins.set(pinName,{x,y});
    const bounds=vertex.bounds, frame=decoder?.bounds??vertex.table?.body;
    const px=frame?(x-frame.x)/frame.width:x/bounds.width;
    const py=frame?(y-frame.y)/frame.height:y/bounds.height;
    return {
      id:decoder?vertex.id+"_p_"+pinName:vertex.id,
      point:{x:bounds.x+x,y:bounds.y+y},
      pin:{x:px,y:py},
    };
  }
  const nets=new Map<string,RoutedWire[]>();
  for(const [i,edge] of layout.edges.entries()){
    const points=routes[i];
    if(points.length<2)continue;
    const start=points[0], end=points[points.length-1];
    const source=edge.source?vertices.get(edge.source):undefined;
    const target=edge.target?vertices.get(edge.target):undefined;
    const from=attach(source,start,edge.sourcePort), to=attach(target,end,edge.targetPort);
    const net=edge.sourcePort??edge.id;
    const wires=nets.get(net)??[];
    wires.push({from,to,points,width:edge.labels?.[0]?.text,label:widthLabels.has(edge.id)});
    nets.set(net,wires);
  }
  function junction(p:Point,width?:string):WireEnd {
    const point=onGrid(p), id="j"+junctions.length;
    const r=Number(width)>1?3:2;
    junctions.push(element("mxCell",{
      id,vertex:1,parent:1,connectable:1,
      style:"shape=ellipse;aspect=fixed;resizable=0;rotatable=0;strokeColor=none;points=[[0.5,0.5,0]];fillColor="+palette.ink+";",
    },geometry({x:point.x-r,y:point.y-r,width:r*2,height:r*2})));
    return {id,point,pin:{x:0.5,y:0.5}};
  }
  function constraint(end:WireEnd,which:"exit"|"entry"):string {
    const pin=end.pin;
    return pin?which+"X="+pin.x+";"+which+"Y="+pin.y+";"+which+"Perimeter=0;":"";
  }
  for(const {from,to,points,width,label} of [...nets.values()].flatMap(wires=>branchWires(wires,junction))){
    const style="edgeStyle=segmentEdgeStyle;orthogonal=1;rounded=0;html=0;endArrow=none;startArrow=none;"
      +"strokeColor="+palette.wire+";strokeWidth="+(Number(width)>1?2:1)
      +";fontColor="+palette.ink+";fontSize=10;labelBackgroundColor="+palette.paper+";"
      +constraint(from,"exit")+constraint(to,"entry");
    const anchor=(p:Point,role:string)=>element("mxPoint",{...pos(p),as:role});
    const projected=simplifyWire(points.map(onGrid));
    const route=reconnect(projected.length>1?projected:simplifyWire(points),from.point,to.point);
    const via=simplifyWire(route).slice(1,-1);
    const hints=(from.id?"":anchor(from.point,"sourcePoint"))+(to.id?"":anchor(to.point,"targetPoint"))
      +(via.length?element("Array",{as:"points"},via.map(p=>element("mxPoint",pos(p))).join("")):"");
    edges.push(element("mxCell",{id:"e"+edges.length,value:width&&label?"/"+width+"/":"",style,edge:1,parent:1,
      ...(from.id?{source:from.id}:{}),...(to.id?{target:to.id}:{})},
      geometry({relative:1},hints)));
  }

  const shapes:string[]=[];
  const frames=children(root).filter(node=>node[1].class==="cdiag-group");
  for(const [i,frame] of frames.entries()){
    const [,rect]=children(frame)[0];
    const value=children(frame)[1].slice(2).filter(part=>typeof part==="string").join("");
    const x=Math.floor(Number(rect.x)/gridSize)*gridSize, y=Math.floor(Number(rect.y)/gridSize)*gridSize;
    const width=Math.ceil((Number(rect.x)+Number(rect.width))/gridSize)*gridSize-x;
    const height=Math.ceil((Number(rect.y)+Number(rect.height))/gridSize)*gridSize-y;
    const style="rounded=1;dashed=1;fillColor=none;html=0;align=left;verticalAlign=top;spacingLeft=7;spacingTop=4;fontStyle=1;"
      +`strokeColor=${palette.ink};fontColor=${palette.ink};`;
    shapes.push(element("mxCell",{id:"group"+i,value,style,vertex:1,parent:1,connectable:0},geometry({x,y,width,height})));
  }
  for(const node of vertices.values()){
    const {id,w,h,bounds,scale,table}=node;
    if(table){
      shapes.push(...table.render(id,bounds,node.pins,palette));
      if(table.accessories.length){
        const parent=id+"_group";
        const shape=editableShape(["g",{},...table.accessories],w,h,palette,[]);
        shapes.push(element("mxCell",{id:id+"_detail",style:shape.style+"pointerEvents=0;",vertex:1,parent,connectable:0},
          geometry({x:0,y:0,width:bounds.width,height:bounds.height})));
        shapes.push(...shape.labels.map((label,i)=>textCell(label,id+"_t"+i,parent,scale)));
      }
      continue;
    }
    const pins=[...node.pins].map(([name,pin])=>({name,x:pin.x/bounds.width,y:pin.y/bounds.height}));
    const shape=editableShape(node.svg,w,h,palette,pins);
    shapes.push(element("mxCell",{id,style:shape.style,vertex:1,parent:1},geometry(bounds)));
    shapes.push(...shape.labels.map((label,i)=>textCell(label,id+"_t"+i,id,scale)));
  }
  const model=element("mxGraphModel",{page:0,grid:1,gridSize,adaptiveColors:"none",background:palette.paper},
    element("root",{},"<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>"+shapes.join("")+edges.join("")+junctions.join("")));
  const file=element("mxfile",{},element("diagram",{id:"cdiag",name:diagram.title||"Diagram"},model));
  return svg.replace(/<svg(?=\s|>)/,tag=>tag+' content="'+xml(file)+'"');
}
