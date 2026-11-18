import type { Block } from "./model.js";
import { children, editableShape, element, geometry, type Palette, type Point, type SvgNode } from "./drawio-shapes.js";

interface Bounds extends Point { width:number; height:number }
interface Decoder { name:string; bounds:Bounds; apex:Point; path:SvgNode }

function boundaries(values:number[], from:number,to:number) {
  return [from,...[...new Set(values)].filter(v=>v>from&&v<to).sort((a,b)=>a-b),to];
}

/** Quantize the shared dividers, so adjoining cells still share one border. */
function gridAxis(cuts:number[],scale:number) {
  const snapped:number[]=[];
  for(const cut of cuts){
    snapped.push(Math.max(Math.round(cut*scale/10)*10,(snapped.at(-1)??-10)+10));
  }
  const project=(n:number)=>{
    const i=cuts.findIndex((cut,i)=>i>0&&cut>=n);
    const end=i<0?cuts.length-1:i;
    const fraction=(n-cuts[end-1])/(cuts[end]-cuts[end-1]);
    return Math.round(snapped[end-1]+fraction*(snapped[end]-snapped[end-1]));
  };
  return {project,snapped};
}

export function planTable(block:Block,svg:SvgNode,size:Point,scale:Point) {
  const items=children(svg);
  const [,frame]=items.find(item=>item[0]==="rect")!;
  const left=Number(frame.x), right=left+Number(frame.width);
  const base=Number(frame.y);
  const rules=items.filter(item=>item[0]==="line").map(([,a])=>a);
  const xCuts=boundaries(rules.filter(a=>a.x1===a.x2).map(a=>Number(a.x1)),left,right);
  const horizontal=rules.filter(a=>a.y1===a.y2).map(a=>Number(a.y1));
  const titleSize=block.recordFields
    ? block.label.split("\n").length*16+20
    : block.structuredTable&&block.label ? Math.min(...horizontal) : base;
  const yCuts=boundaries([...horizontal,titleSize],0,size.y);
  const colAxis=gridAxis(xCuts,scale.x), rowAxis=gridAxis(yCuts,scale.y);
  const leftOnGrid=colAxis.snapped[0], rightOnGrid=colAxis.snapped.at(-1)!;
  const body:Bounds={x:leftOnGrid,y:0,width:rightOnGrid-leftOnGrid,height:rowAxis.snapped.at(-1)!};
  const titleHeight=rowAxis.project(titleSize);
  const rows=rowAxis.snapped.filter(y=>y>=titleHeight);
  const project=(point:Point):Point=>({x:colAxis.project(point.x),y:rowAxis.project(point.y)});
  const halfGrid=(n:number)=>Math.round(n/5)*5;
  const decoders=new Map<string,Decoder>();
  const accessories:SvgNode[]=[];
  for(const item of items){
    const [,a]=item;
    if(a["data-index"]){
      const [x0,y0,x1,y1,,y2]=a.d.match(/-?[\d.]+/g)!.map(Number);
      const baseX=colAxis.project(x0);
      const top=halfGrid(rowAxis.project(y0)), bottom=halfGrid(rowAxis.project(y2));
      const width=Math.max(5,halfGrid(Math.abs(x1-x0)*scale.x));
      const height=Math.max(5,bottom-top);
      const apex={x:baseX+Math.sign(x1-x0)*width,y:Math.max(top,Math.min(top+height,rowAxis.project(y1)))};
      const bounds={x:Math.min(baseX,apex.x),y:top,width,height};
      const stem=baseX-bounds.x, tip=apex.x-bounds.x;
      const path:SvgNode=["path",{...a,d:`M ${stem},0 L ${tip},${apex.y-bounds.y} L ${stem},${bounds.height} Z`}];
      const name=a["data-index"];
      decoders.set(name,{name,bounds,apex,path});
    }else if(block.table&&(item[0]==="path"||item[0]==="text"&&Number(a.x)<left)){
      accessories.push(item);
    }
  }
  const fill=frame.fill, title=block.label;
  const record=block.recordFields?.map(f=>[`${f.label} [${f.width}]`,`[${f.msb}:${f.lsb}]`,f.use].filter(Boolean).join("\n"));
  const fields=block.structuredTable?.fields.map(f=>`${f.label} [${f.width}]`)??block.table?.columns;

  function render(id:string,outer:Bounds,pins:Map<string,Point>,palette:Palette) {
    const group=decoders.size>0||accessories.length>0;
    const parent=group?id+"_group":"1";
    const out:string[]=[];
    const vertex=(id:string,value:string,style:string,parent:string,bounds:Bounds,connectable:boolean)=>
      element("mxCell",{id,value,style,parent,vertex:1,connectable:connectable?1:0},geometry({...bounds}));
    if(group)out.push(vertex(parent,"","group;", "1",outer,false));
    const points=[...pins].filter(([name])=>!decoders.has(name)).map(([,pin])=>[
      (pin.x-body.x)/body.width,(pin.y-body.y)/body.height,0,
    ]);
    const tableStyle="shape=table;childLayout=tableLayout;container=1;collapsible=0;fixedHeader=1;"
      +"tableRender=collapsed;html=0;whiteSpace=wrap;fontStyle=1;fontSize=13;align=center;verticalAlign=middle;"
      +`startSize=${titleHeight};fillColor=${fill};swimlaneFillColor=${fill};strokeColor=${palette.ink};fontColor=${palette.ink};points=${JSON.stringify(points)};`;
    const tableBounds=group?body:{...body,x:outer.x+body.x,y:outer.y+body.y};
    out.push(vertex(id,title,tableStyle,parent,tableBounds,true));
    const rowStyle="shape=tableRow;horizontal=0;startSize=0;swimlaneHead=0;swimlaneBody=0;"
      +"collapsible=0;dropTarget=0;fillColor=none;strokeColor=inherit;fixedHeader=1;";
    const cellStyle="shape=partialRectangle;html=0;connectable=0;strokeColor=inherit;pointerEvents=1;"
      +`align=center;verticalAlign=middle;fontFamily=Helvetica;fontSize=10;fontColor=${palette.ink};`;
    rows.slice(0,-1).forEach((y,i)=>{
      const row=id+"_r"+i, height=rows[i+1]-y;
      const selected=block.structuredTable?.selected===i-1&&i>0;
      const ellipsis=block.structuredTable?.ellipsis&&i===block.structuredTable.rows-1
        ||block.table?.ellipsis&&i===block.table.rows-2;
      const values=i===0?(record??fields):undefined;
      out.push(vertex(row,"",rowStyle,id,{x:0,y,width:body.width,height},false));
      colAxis.snapped.slice(0,-1).forEach((x,col)=>{
        const value=values?.[col]??(ellipsis?"⋮":"");
        const style=cellStyle+`fillColor=${selected?palette.accent:"none"};fontStyle=${i===0&&!record?1:0};`;
        const width=colAxis.snapped[col+1]-x;
        out.push(vertex(row+"_c"+col,value,style,row,{x:x-body.x,y:0,width,height},false));
      });
    });
    for(const {name,bounds,apex,path} of decoders.values()){
      const shape=editableShape(["g",{},path],bounds.width,bounds.height,palette,[
        {name,x:(apex.x-bounds.x)/bounds.width,y:(apex.y-bounds.y)/bounds.height},
      ]);
      out.push(vertex(id+"_p_"+name,"",shape.style,parent,bounds,true));
    }
    return out;
  }
  return {body,decoders,accessories,project,render};
}
