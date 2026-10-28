"""Generate a per-diagram Netlist2SVG skin with exact port anchors.

Netlist2SVG's fixed templates use s:type, s:width, s:height and s:x/y/pid.
The layout of each cell is independent of its HDL semantics.
"""
from __future__ import annotations
from html import escape
import math
from pathlib import Path
import xml.etree.ElementTree as ET
from .model import Diagram

S = 'https://github.com/ajsb85/netlist2svg'
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
ET.register_namespace('s', S)

PALETTES = {
 'light': {'ink':'#253858','wire':'#344b66','paper':'#ffffff','logic':'#e7f0fc','storage':'#e5f5ee','control':'#f0ecff','neutral':'#f4f6fa','accent':'#fff0cd'},
 'dark': {'ink':'#dbeafe','wire':'#b3c9ea','paper':'#142033','logic':'#23446b','storage':'#185348','control':'#433268','neutral':'#263b53','accent':'#71551d'},
 'mono': {'ink':'#242424','wire':'#333333','paper':'#ffffff','logic':'#ffffff','storage':'#ffffff','control':'#ffffff','neutral':'#ffffff','accent':'#eeeeee'},
}
PRESETS = {
 'compact': {'layers':24,'nodes':20,'edge':12},
 'balanced': {'layers':45,'nodes':38,'edge':20},
 'feedback': {'layers':36,'nodes':46,'edge':25},
}

def _a(name):
 return '{%s}%s' % (S,name)
def _t(name):
 return '{%s}%s' % (SVG,name)

def e(parent, tag, attrs=None, content=None):
 node=ET.SubElement(parent,_t(tag), {str(k):str(v) for k,v in (attrs or {}).items()})
 if content is not None: node.text=str(content)
 return node

def s(parent, tag, attrs=None):
 return ET.SubElement(parent,_a(tag), {str(k):str(v) for k,v in (attrs or {}).items()})

def _port_anchor(g, pname, x, y):
 e(g,'g',{_a('x'):round(x,2), _a('y'):round(y,2), _a('pid'):pname})

# Unlike arbitrary modules, small operators should not inherit the generous
# generic box margins. These are visual-only shapes, not synthesis elements.
COMPACT_OPERATORS = {'ADD','SUB','SHIFT','SHL','SHR','SAR','CMP','AND','OR','XOR','NOT'}


def _layout_of(block):
 sides={k:[] for k in ('west','east','north','south')}
 for p in block.ports.values():
  sides[p.side or ('west' if p.direction=='input' else 'east')].append(p)
 if block.type in COMPACT_OPERATORS:
  # Small, rounded operator cells with room for their names and port labels.
  width=max(66, 42 + len(block.label)*7.5,
            30 + 13*max(len(sides['north']),len(sides['south'])))
  height=max(50, 19*max(len(sides['west']),len(sides['east']))+14)
 elif block.type=='MUX':
  # A trapezoid whose output is substantially narrower than its input edge.
  width=max(67, 32 + len(block.label)*7)
  height=max(78, 24*max(len(sides['west']),len(sides['east']))+30)
 elif block.type=='ALU':
  width=max(110, 40+len(block.label)*8)
  height=max(100, 32*max(len(sides['west']),len(sides['east']))+40)
 else:
  label_len=max(len(line) for line in block.label.splitlines())
  side_limit=max((len(p.name) for p in sides['west']),default=0)+max((len(p.name) for p in sides['east']),default=0)
  width=max(108, 18 + label_len*7.5, 42+side_limit*7.2, 54+25*max(len(sides['north']),len(sides['south'])))
  height=max(70, 54+24*max(len(sides['west']),len(sides['east'])), 100 if sides['north'] and sides['south'] else 70)
 return int(math.ceil(width)),int(math.ceil(height)),sides

def _fill(block):
 if block.type in {'ALU','ADD','SUB','CMP','SHIFT','SHL','SHR','SAR','AND','OR','XOR','NOT'}: return 'logic'
 if block.type in {'DFF','SRAM'}: return 'storage'
 if block.type in {'MUX'}: return 'control'
 return 'neutral'

def _draw_block(root,block,palette):
 width,height,sides=_layout_of(block)
 g=e(root,'g',{_a('type'):'cdiag_'+block.id,'transform':'translate(30,20)', _a('width'):width, _a('height'):height})
 s(g,'alias',{'val':'CDL__'+block.id})
 ink=palette['ink']; fill=palette[block.style if block.style in palette else _fill(block)]
 attrs={'stroke':ink,'stroke-width':'1.6','fill':fill,'class':'symbol $cell_id'}
 typ=block.type
 if typ=='MUX':
  # Common 2:1 mux symbol: broad left side, narrow vertical output end,
  # data ports left, selection usually enters through lower sloping side.
  narrow=0.23*height
  e(g,'path',dict(attrs,d=f'M 0,0 L {width},{(height-narrow)/2:.2f} '
                             f'L {width},{(height+narrow)/2:.2f} L 0,{height} Z'))
 elif typ=='ALU':
  # Classic left-notched ALU silhouette (like textbooks/Patterson-Hennessy):
  # two wide operand shoulders and a central concave V, slanted upper/lower
  # edges, and a vertical output face. Not a rectangular block with a nub.
  notch=width*.18
  e(g,'path',dict(attrs,d=f'M 0,0 L {width},{.22*height:.2f} '
                             f'L {width},{.78*height:.2f} L 0,{height} '
                             f'L 0,{.65*height:.2f} L {notch:.2f},{.5*height:.2f} '
                             f'L 0,{.35*height:.2f} Z'))
 elif typ in COMPACT_OPERATORS:
  e(g,'rect',dict(attrs,x=0,y=0,width=width,height=height,rx=9,ry=9))
 elif typ=='DFF':
  e(g,'rect',dict(attrs,x=0,y=0,width=width,height=height,rx=3))
  clk=block.ports.get('CLK')
  side=(clk.side if clk else None) or 'west'
  if side=='west': path=f'M 0,{height-16} l 9,6 -9,6'
  elif side=='south': path=f'M {width/2-6},{height} l 6,-9 6,9'
  elif side=='north': path=f'M {width/2-6},0 l 6,9 6,-9'
  else: path=f'M {width},{height-16} l -9,6 9,6'
  e(g,'path',{'d':path,'stroke':ink,'stroke-width':1.8,'fill':'none'})
 elif typ=='SRAM':
  # Plain SRAM rectangle: intentionally no decorative separator/grid lines.
  e(g,'rect',dict(attrs,x=0,y=0,width=width,height=height,rx=4))
 else:
  e(g,'rect',dict(attrs,x=0,y=0,width=width,height=height,rx=4 if typ=='box' else 3))

 title=block.label if block.label!='box' else block.id
 if typ in COMPACT_OPERATORS:
  title_x,title_y,title_size=width/2,height/2+4,11
 elif typ=='MUX':
  title_x,title_y,title_size=width*.48,height*.50+4,11
 elif typ=='ALU':
  title_x,title_y,title_size=width*.60,height*.50+4,13
 else:
  title_x,title_y,title_size=width/2,21,13
 e(g,'text',{'x':round(title_x,2),'y':round(title_y,2),'text-anchor':'middle',
             'font-size':title_size,'font-weight':'bold','fill':ink,'stroke':'none'},title)

 for side,ports in sides.items():
  for i,p in enumerate(ports):
   count=len(ports)
   if side in ('west','east'):
    if typ in COMPACT_OPERATORS or typ in ('MUX','ALU'):
     y=(height*(.23 if i==0 else .77) if typ=='ALU' and side=='west' and count==2
        else height*(i+1)/(count+1))
     if typ=='ALU' and side=='west':
      # Move pin onto the surface of the V-shaped concavity if necessary.
      delta=abs(y-height*.5)
      x=width*.18*max(0,1-delta/(height*.15))
     else:
      x=0 if side=='west' else width
     if typ=='MUX' and side=='east': y=height*.5
    else:
     x=0 if side=='west' else width
     y=43+i*24
    tx=x+7 if side=='west' else x-7
    ty=y-4
    anchor='start' if side=='west' else 'end'
   else:
    x=width*(i+1)/(count+1)
    if typ=='MUX':
     # Put select pins ON the sloping contour, not on the bounding box.
     y=height*.385*(x/width) if side=='north' else height-height*.385*(x/width)
    elif typ=='ALU':
     y=height*.22*(x/width) if side=='north' else height-height*.22*(x/width)
    else:
     y=0 if side=='north' else height
    if typ in ('MUX','ALU'):
     ty=y+13 if side=='north' else y-8
    elif typ in COMPACT_OPERATORS:
     ty=y+12 if side=='north' else y-6
    else:
     ty=35 if side=='north' else height-12
    tx=x;anchor='middle'
   _port_anchor(g,p.name,x,y)
   e(g,'text',{'x':round(tx,2),'y':round(ty,2),'text-anchor':anchor,
               'font-size':9 if typ in COMPACT_OPERATORS else 10,
               'fill':ink,'stroke':'none'},p.name)
 return width,height

def _essentials(root,palette):
 """Special nodes used internally by Netlist2SVG. Keep their `s:generic` hooks."""
 ink=palette['ink']
 for kind in ('inputExt','outputExt','constant'):
  g=e(root,'g',{_a('type'):kind,'transform':'translate(0,0)',_a('width'):30,_a('height'):20})
  s(g,'alias',{'val':'$_'+kind+'_'})
  e(g,'text',{'x':15,'y':-4,'class':'nodelabel $cell_id',_a('attribute'):'ref'},kind)
  if kind=='inputExt': e(g,'path',{'d':'M0,0 L0,20 L15,20 L30,10 L15,0 Z','class':'symbol $cell_id'})
  elif kind=='outputExt': e(g,'path',{'d':'M30,0 L30,20 L15,20 L0,10 L15,0 Z','class':'symbol $cell_id'})
  else: e(g,'rect',{'width':30,'height':20,'class':'symbol $cell_id'})
  _port_anchor(g,'A' if kind=='outputExt' else 'Y',0 if kind=='outputExt' else 30,10)
 for kind in ('split','join'):
  g=e(root,'g',{_a('type'):kind,'transform':'translate(0,0)',_a('width'):5,_a('height'):40})
  s(g,'alias',{'val':'$_'+kind+'_'})
  e(g,'rect',{'width':5,'height':40,'class':'splitjoinBody',_a('generic'):'body'})
  _port_anchor(g,'in' if kind=='split' else 'out',0 if kind=='split' else 5,20)
  for i,y in enumerate((10,30)):
   x=5 if kind=='split' else 0
   p=e(g,'g',{'transform':f'translate({x},{y})',_a('x'):x,_a('y'):y,_a('pid'):('out' if kind=='split' else 'in')+str(i)})
   e(p,'text',{'x':5 if kind=='split' else -3,'y':-4,'class':'inputPortLabel' if kind=='join' else ''},'hi:lo')
 # Generic node fallback required even if every DSL block has custom type.
 g=e(root,'g',{_a('type'):'generic','transform':'translate(0,0)',_a('width'):60,_a('height'):50})
 e(g,'text',{'x':30,'y':-4,'class':'nodelabel $cell_id',_a('attribute'):'ref'},'generic')
 e(g,'rect',{'width':60,'height':50,_a('generic'):'body','class':'symbol $cell_id'})
 for x,y,pname,kind in [(0,12,'in0','west'),(0,38,'in1','west'),(60,12,'out0','east'),(60,38,'out1','east')]:
  a=e(g,'g',{'transform':f'translate({x},{y})',_a('x'):x,_a('y'):y,_a('pid'):pname})
  e(a,'text',{'x':-3 if kind=='west' else 5,'y':-4,'class':'inputPortLabel' if kind=='west' else ''},pname)
 for name in ('sub_odd','sub_even'):
  a=ET.fromstring(ET.tostring(g))
  a.set(_a('type'),name)
  a.find(_t('rect')).set('fill',palette['neutral'])
  root.append(a)

def generate_skin(diagram:Diagram,theme: str|None=None,layout:str|None=None) -> str:
 theme=theme or diagram.theme;layout=layout or diagram.layout
 if theme not in PALETTES: raise ValueError('invalid theme: '+theme)
 if layout not in PRESETS: raise ValueError('invalid layout preset: '+layout)
 palette=PALETTES[theme];preset=PRESETS[layout]
 root=ET.Element(_t('svg'),{'xmlns:xlink':'http://www.w3.org/1999/xlink','width':'800','height':'500'})
 css=f'''svg {{ stroke: {palette['wire']}; fill: none; }}
  text {{ fill: {palette['ink']}; stroke: none; font-family: sans-serif; font-size: 10px; }}
  .nodelabel {{ text-anchor: middle; }} .inputPortLabel {{ text-anchor: end; }}
  .symbol {{ stroke: {palette['ink']}; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }}
  .splitjoinBody,.junction {{ fill: {palette['ink']}; }}
  .labelBackground {{ fill: {palette['paper']}; stroke:none; }}
  .detail {{ fill:{palette['ink']}; }}
  line {{ stroke: {palette['wire']}; }}
  .cdiag-net-label {{ font-family: sans-serif; font-size: 10px; fill: {palette['ink']}; }}
  .cdiag-net-label-bg {{ fill:{palette['paper']}; stroke:none; }}'''
 e(root,'style',content=css)
 props=s(root,'properties')
 elk={'org.eclipse.elk.direction':{'LR':'RIGHT','RL':'LEFT','TB':'DOWN','BT':'UP'}[diagram.direction],
      'org.eclipse.elk.edgeRouting':'ORTHOGONAL',
      'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers':preset['layers'],
      'org.eclipse.elk.spacing.nodeNode':preset['nodes'],
      'org.eclipse.elk.spacing.edgeNode':preset['edge'],
      'org.eclipse.elk.layered.cycleBreaking.strategy':'GREEDY',
      'org.eclipse.elk.layered.layering.strategy':'LONGEST_PATH'}
 s(props,'layoutEngine',elk)
 for b in diagram.blocks.values():
  if b.type=='DFF': s(props,'low_priority_alias',{'value':'CDL__'+b.id})
 _essentials(root,palette)
 for b in diagram.blocks.values(): _draw_block(root,b,palette)
 ET.indent(root,space='  ')
 return ET.tostring(root,encoding='unicode',xml_declaration=True)
