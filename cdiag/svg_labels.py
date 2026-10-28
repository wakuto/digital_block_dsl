"""Optional visible labels for named nets in SVG emitted by Netlist2SVG.

Netlist2SVG tags wires with CSS class net_<bit-ids> (observed in v1 output).
If the upstream format changes, fail rather than silently skip requested labels.
"""
from __future__ import annotations
from pathlib import Path
import xml.etree.ElementTree as ET
from .model import Diagram, DiagramError
from .skin import PALETTES, SVG

ET.register_namespace('', SVG)

def annotate(svg_path: str|Path,diagram:Diagram,netlist:dict, output: str|Path|None=None):
    svg_path=Path(svg_path)
    output=Path(output or svg_path)
    tree=ET.parse(svg_path)
    root=tree.getroot()
    if root.get('data-cdiag-netlabels') == '1':
        if output != svg_path:
            output.write_bytes(svg_path.read_bytes())
        return output
    root.set('data-cdiag-netlabels','1')
    nets=netlist['modules']['top'].get('netnames',{})
    palette=PALETTES[diagram.theme]
    existing_classes = {}
    for child in root.iter():
        if child.tag == '{%s}line'%SVG:
            for label in child.attrib.get('class','').split():
                if label.startswith('net_'):
                    existing_classes.setdefault(label,[]).append(child)
    missing=[]
    for name,entry in nets.items():
        cls='net_'+','.join(str(bit) for bit in entry['bits'])
        candidates=existing_classes.get(cls,[])
        if not candidates:
            missing.append(name)
            continue
        def score(el):
            x1,y1,x2,y2=[float(el.attrib[k]) for k in ('x1','y1','x2','y2')]
            length=abs(x2-x1)+abs(y2-y1)
            return (abs(y2-y1)<.01,length)
        segment=max(candidates,key=score)
        x1,y1,x2,y2=[float(segment.attrib[k]) for k in ('x1','y1','x2','y2')]
        midx=(x1+x2)/2;midy=(y1+y2)/2
        # Label is above the horizontal segment, to avoid obscuring the wire.
        width=max(22,len(name)*6.5+8)
        ET.SubElement(root,'{%s}rect'%SVG,{'x':str(round(midx-width/2,2)), 'y':str(round(midy-17,2)),
                     'width':str(round(width,2)), 'height':'13','rx':'2','class':'cdiag-net-label-bg',
                     'fill':palette['paper'],'stroke':'none'})
        t=ET.SubElement(root,'{%s}text'%SVG,{'x':str(round(midx,2)), 'y':str(round(midy-7,2)),
                        'text-anchor':'middle','class':'cdiag-net-label','fill':palette['ink'],'stroke':'none'})
        t.text=name
    if missing:
        raise DiagramError('E306', 'cannot locate Netlist2SVG wire classes for named net(s): '+', '.join(missing))
    output.parent.mkdir(parents=True,exist_ok=True)
    tree.write(output, encoding='unicode',xml_declaration=True)
    return output
