import type { NetlistGraph } from "./port-layout.js";
import { number, type Point } from "./drawio-shapes.js";

type Edge=NetlistGraph["edges"][number];
type Span=[number,number];
type Axis=keyof Point;
type Rect=Point & {width:number;height:number};

export const samePoint=(a:Point,b:Point)=>a.x===b.x&&a.y===b.y;
export const position=(p:Point):Point=>({x:number(p.x),y:number(p.y)});
export interface WireEnd {
  point:Point;
  id?:string;
  pin?:Point;
}
export interface RoutedWire {
  from:WireEnd;
  to:WireEnd;
  points:Point[];
  width?:string;
  label:boolean;
}

export function edgePoints(edge:Edge):Point[] {
  const points=(edge.sections??[]).flatMap(section=>[
    section.startPoint,...section.bendPoints??[],section.endPoint,
  ]).map(position);
  return points.filter((p,i)=>i===0||!samePoint(p,points[i-1]));
}

function longestRun(points:Point[]):number {
  return Math.max(0,...points.slice(1).map((p,i)=>
    Math.abs(p.x-points[i].x)+Math.abs(p.y-points[i].y)));
}

/** A driver may fan out to several ELK edges, each with a copy of its bus width. */
export function widthLabelEdges(edges:Edge[]):Set<string> {
  const selected=new Map<string,{id:string;room:number}>();
  for(const edge of edges){
    const width=edge.labels?.[0]?.text;
    if(!width)continue;
    const key=edge.sourcePort?edge.sourcePort+"/"+width:edge.id;
    const points=edgePoints(edge);
    const room=longestRun(points);
    if(points.length>1&&room>(selected.get(key)?.room??-1)){
      selected.set(key,{id:edge.id,room});
    }
  }
  return new Set([...selected.values()].map(edge=>edge.id));
}

interface Fork {
  point:Point;
  next:Map<string,Fork>;
  sinks:WireEnd[];
}

function fork(point:Point):Fork {
  return {point,next:new Map(),sinks:[]};
}

/** Split shared route prefixes at actual forks, including bends inside another route's run. */
export function branchWires(wires:RoutedWire[],createJunction:(point:Point,width?:string)=>WireEnd):RoutedWire[] {
  if(wires.length===1)return wires;
  const vertices=[...new Map(wires.flatMap(wire=>wire.points).map(p=>[`${p.x},${p.y}`,p])).values()];
  const root=fork(wires[0].points[0]);
  for(const wire of wires){
    let current=root;
    for(const [i,end] of wire.points.slice(1).entries()){
      const start=wire.points[i], across=start.x===end.x?"x":"y", along=across==="x"?"y":"x";
      const direction=Math.sign(end[along]-start[along]);
      const interior=vertices.filter(p=>p[across]===start[across]&&
        direction*(p[along]-start[along])>0&&direction*(end[along]-p[along])>0);
      interior.sort((a,b)=>direction*(a[along]-b[along]));
      for(const p of [...interior,end]){
        const key=`${p.x},${p.y}`;
        const next=current.next.get(key)??fork(p);
        current.next.set(key,next);
        current=next;
      }
    }
    current.sinks.push(wire.to);
  }

  const width=wires.find(wire=>wire.width)?.width;
  const result:RoutedWire[]=[];
  const emit=(from:WireEnd,to:WireEnd,points:Point[])=>result.push({from,to,points,width,label:false});
  function walk(node:Fork,from:WireEnd,points:Point[]) {
    const path=[...points,node.point];
    if(node.next.size+node.sinks.length>1){
      const joint=createJunction(node.point,width);
      emit(from,joint,path);
      for(const sink of node.sinks)emit(joint,sink,[node.point,node.point]);
      for(const next of node.next.values())walk(next,joint,[node.point]);
    }else if(node.sinks.length){
      emit(from,node.sinks[0],path);
    }else{
      for(const next of node.next.values())walk(next,from,path);
    }
  }

  const source=wires[0].from;
  if(root.next.size===1){
    for(const next of root.next.values())walk(next,source,[root.point]);
  }else{
    // If routes leave the port in different directions, put a short stem on an
    // existing run and turn the other branches to meet it beyond the port.
    const exits=[...root.next.values()];
    const first=exits.reduce((a,b)=>longestRun([root.point,b.point])>longestRun([root.point,a.point])?b:a);
    const along=first.point.x===root.point.x?"y":"x", across=along==="x"?"y":"x";
    const run=first.point[along]-root.point[along];
    const point={...root.point,[along]:number(root.point[along]+Math.sign(run)*Math.min(10,Math.abs(run)/2))};
    const joint=createJunction(point,width);
    emit(source,joint,[root.point,point]);
    for(const next of exits){
      const at=next.point;
      const lead=next===first?[point]:at[across]!==point[across]
        ?[point,{...point,[across]:at[across]}]
        :[point,{...point,[across]:point[across]+5},{...at,[across]:at[across]+5}];
      walk(next,joint,lead);
    }
  }
  if(wires.some(wire=>wire.label)){
    // Keep the label on the stem when it fits, otherwise use the roomiest branch.
    const best=longestRun(result[0].points)>=24?result[0]:result.reduce((a,b)=>
      longestRun(b.points)>longestRun(a.points)?b:a);
    best.label=true;
  }
  return result;
}

/** Drop duplicate points and intermediate stops along a straight run. */
export function simplifyWire(points:Point[]):Point[] {
  const result:Point[]=[];
  for(const p of points){
    const b=result.at(-1), a=result.at(-2);
    if(b&&samePoint(b,p))continue;
    if(a&&b&&(a.x===b.x&&b.x===p.x||a.y===b.y&&b.y===p.y))result.pop();
    if(!result.length||!samePoint(result.at(-1)!,p))result.push(p);
  }
  return result;
}

export function snapWireTracks(routes:Point[][],obstacles:Rect[]) {
  const tracks:Record<Axis,Map<number,Span[]>>={x:new Map(),y:new Map()};
  for(const route of routes){
    for(const [i,b] of route.slice(1).entries()){
      const a=route[i];
      const fixed=a.x===b.x?"x":"y", along=fixed==="x"?"y":"x";
      if(a[fixed]!==b[fixed])continue;
      const lane=tracks[fixed].get(a[fixed])??[];
      lane.push([Math.min(a[along],b[along]),Math.max(a[along],b[along])]);
      tracks[fixed].set(a[fixed],lane);
    }
  }

  function mapAxis(axis:Axis) {
    const lanes=tracks[axis];
    const moved=new Map<number,number>();
    const along=axis==="x"?"y":"x";
    const depth=axis==="x"?"width":"height", length=axis==="x"?"height":"width";
    const overlaps=(a:Span,b:Span,margin:number)=>a[0]<b[1]+margin&&b[0]<a[1]+margin;
    const entries=[...lanes].sort(([a],[b])=>a-b);
    for(const [coordinate,spans] of entries){
      const before=(candidate:number)=>!entries.some(([other,otherSpans])=>{
        const neighbor=moved.get(other)??other;
        if(other===coordinate||Math.abs(other-coordinate)>12)return false;
        // Keep the order and separation of neighboring tracks wherever they run alongside each other.
        return Math.sign(other-coordinate)*(neighbor-candidate)<Math.min(3,Math.abs(other-coordinate))
          && spans.some(s=>otherSpans.some(o=>overlaps(s,o,5)));
      });
      const clear=(candidate:number)=>!obstacles.some(rect=>{
        const low=rect[axis],high=low+rect[depth];
        return (coordinate<=low||coordinate>=high)&&candidate>=low&&candidate<=high
          && spans.some(s=>overlaps(s,[rect[along],rect[along]+rect[length]],0));
      });
      const options=[10,5].map(step=>Math.round(coordinate/step)*step);
      moved.set(coordinate,options.find(c=>c===coordinate||before(c)&&clear(c))??coordinate);
    }
    return (coordinate:number)=>moved.get(coordinate)??coordinate;
  }
  const x=mapAxis("x"), y=mapAxis("y");
  return (p:Point):Point=>({x:x(p.x),y:y(p.y)});
}
