"""Visual preview of generated symbol templates without the npm layout engine."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xml.etree import ElementTree as ET
from cdiag.parser import parse
from cdiag.skin import SVG,S,PALETTES,_draw_block

source='''version 1 diagram "Symbol Gallery" {
    a: ADD(width=32)
    b: SUB(width=32)
    c: SHL(width=32)
    d: SHR(width=32)
    e: SAR(width=32)
    f: SHIFT(width=32)
    g: CMP(width=32)
    h: ALU(width=64,op_width=4)
    i: MUX(width=32) {in S@south}
    j: DFF(width=32) {in CLK@north label "Result Register"}
    k: SRAM(width=64,addr_width=32)
    l: box "Custom Module" { in REQUEST[32], VALID out RESPONSE[32] }
}'''
d=parse(source)
ET.register_namespace('',SVG);ET.register_namespace('s',S)
root=ET.Element('{%s}svg'%SVG,{'width':'1290','height':'790','viewBox':'0 0 1290 790'})
ET.SubElement(root,'{%s}rect'%SVG,{'x':'0','y':'0','width':'1290','height':'790','fill':'#ffffff'})
ET.SubElement(root,'{%s}text'%SVG,{'x':'30','y':'36','fill':'#283b57','font-size':'21','font-family':'sans-serif','font-weight':'bold'}).text='Circuit Diagram DSL v0.4 — symbol templates'
for i,b in enumerate(d.blocks.values()):
 col=i%4;row=i//4
 W=298;H=224
 gx=26+col*310; gy=65+row*235
 panel=ET.SubElement(root,'{%s}rect'%SVG,{'x':str(gx),'y':str(gy),'width':str(W),'height':str(H),'rx':'8','fill':'#f8fafc','stroke':'#e2e8f0'})
 group=ET.SubElement(root,'{%s}g'%SVG)
 _draw_block(group,b,PALETTES['light'])
 cell=group[-1]
 # Center varying-size symbols in panel for an accurate visual comparison.
 w=float(cell.attrib['{%s}width'%S]);h=float(cell.attrib['{%s}height'%S])
 cell.set('transform',f'translate({gx+(W-w)/2:.2f},{gy+(H-h)/2-4:.2f})')
 ET.SubElement(root,'{%s}text'%SVG,{'x':str(gx+13),'y':str(gy+H-14),'fill':'#66768b','font-size':'11','font-family':'sans-serif'}).text=b.type + '  /  '+b.id
ET.indent(root,space='  ')
out=Path(__file__).resolve().parents[1]/'build'/'symbol_gallery.svg';out.parent.mkdir(exist_ok=True);out.write_text(ET.tostring(root,encoding='unicode',xml_declaration=True))
print(out)
