"""Skin/Netlist integration tests; renderer integration needs external npm binary."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET
import pytest
from cdiag.parser import parse, parse_file
from cdiag.backends import yosys_json, write_bundle
from cdiag.skin import generate_skin, S, SVG
from cdiag.svg_labels import annotate
from cdiag.model import DiagramError
from cdiag.cli import main

ROOT=Path(__file__).resolve().parents[1]

def target(d):
    return parse_file(ROOT/'examples'/d)

def root_of(s): return ET.fromstring(s)

def locate(root,kind):
    return next(x for x in root.iter() if x.attrib.get('{%s}type'%S)==kind)

def anchors(g):
    return {x.attrib['{%s}pid'%S]:(float(x.attrib['{%s}x'%S]), float(x.attrib['{%s}y'%S]))
            for x in g.iter() if '{%s}pid'%S in x.attrib}

def test_generated_skin_valid_and_custom_cell_types():
    d=target('execution.cdl')
    doc=root_of(generate_skin(d))
    n=yosys_json(d,custom_skin=True)['modules']['top']
    for id,b in d.blocks.items():
        cell=n['cells'][id]
        assert cell['type']=='CDL__'+id
        assert 'WIDTH' not in cell['parameters'] # avoid implicit -bus suffix
        symbol=locate(doc,'cdiag_'+id)
        assert any(v.attrib.get('val')==cell['type'] for v in symbol.iter())
        assert anchors(symbol).keys()==b.ports.keys()
    for special in ['inputExt','outputExt','constant','split','join','generic','sub_odd','sub_even']:
        locate(doc,special)

def test_side_positions_and_clock():
    d=target('execution.cdl')
    root=root_of(generate_skin(d))
    block=locate(root,'cdiag_mem');pts=anchors(block)
    assert pts['CLK'][1]==0
    assert pts['RDATA'][0]==float(block.get('{%s}width'%S))
    assert pts['ADDR'][0]==0

def test_sram_label_auto_size():
    d=parse('''version 1 diagram "t" { input a output y
        a -> mem.A mem.Y -> y
        mem: box "A very long SRAM or Cache Subsystem" { in A out Y }
    }''')
    root=root_of(generate_skin(d))
    assert float(locate(root,'cdiag_mem').get('{%s}width'%S))>200

def test_builtins_use_different_shapes():
    d=target('execution.cdl');root=root_of(generate_skin(d))
    dff=locate(root,'cdiag_reg0'); mux=locate(root,'cdiag_mux0')
    assert any(el.tag.endswith('rect') for el in dff)
    assert any(el.tag.endswith('path') for el in mux)
    assert any(el.tag.endswith('text') and el.text=='DFF' for el in dff)

def test_theme_layout_and_style():
    src='''version 1 diagram "x" {direction TB theme dark layout compact netlabels off
        input a output y b: box "Block" {style accent in A@north out Y@south}
        a -> b.A b.Y -> y
    }'''
    d=parse(src)
    assert d.theme=='dark' and d.layout=='compact' and not d.netlabels and d.blocks['b'].style=='accent'
    root=root_of(generate_skin(d))
    engine=next(x for x in root.iter() if x.tag=='{%s}layoutEngine'%S)
    assert engine.attrib['org.eclipse.elk.direction']=='DOWN'
    assert engine.attrib['org.eclipse.elk.edgeRouting']=='ORTHOGONAL'
    assert anchors(locate(root,'cdiag_b'))['A'][1]==0

def test_all_samples_have_consistent_netlists():
    for name in ['execution','memory_pipeline','scheduler','netlist2svg_ready','complex_feedback']:
        d=target(name+'.cdl')
        model=yosys_json(d, custom_skin=True)['modules']['top']
        bit_ids=set()
        for net in d.nets:
            bits=model['ports'][net.driver]['bits'] if '.' not in net.driver else model['cells'][net.driver.split('.')[0]]['connections'][net.driver.split('.')[1]]
            bit_ids.update(bits)
            for sink in net.sinks:
                sinkbits=model['ports'][sink]['bits'] if '.' not in sink else model['cells'][sink.split('.')[0]]['connections'][sink.split('.')[1]]
                assert bits==sinkbits
        assert len(bit_ids)>0
        root_of(generate_skin(d))

def test_bundle_cli(tmp_path):
    base=tmp_path/'diagram'
    assert main(['bundle',str(ROOT/'examples/execution.cdl'),'-o',str(base),'--theme','mono','--layout','feedback'])==0
    model=json.loads((tmp_path/'diagram.json').read_text())
    assert model['modules']['top']['cells']['reg0']['type']=='CDL__reg0'
    root_of((tmp_path/'diagram.skin.svg').read_text())

def test_svg_annotation_success(tmp_path):
    d=parse('''version 1 diagram "x" { input a[8] output b[8] net data[8] = a -> b }''')
    netlist=yosys_json(d,custom_skin=True)
    bits=netlist['modules']['top']['netnames']['data']['bits']
    cl='net_'+','.join(map(str,bits))+' width_8'
    src=tmp_path/'raw.svg'
    src.write_text(f'<svg xmlns="{SVG}" width="300" height="200"><line class="{cl}" x1="10" y1="30" x2="230" y2="30"/></svg>')
    annotated=annotate(src,d,netlist,tmp_path/'result.svg')
    root=ET.parse(annotated).getroot()
    assert any(el.text=='data' for el in root.iter() if el.tag.endswith('text'))

def test_svg_annotation_missing_net_rejected(tmp_path):
    d=parse('version 1 diagram "x" { input a output b net wire = a -> b }')
    src=tmp_path/'raw.svg';src.write_text(f'<svg xmlns="{SVG}" />')
    with pytest.raises(DiagramError,match='cannot locate'):
        annotate(src,d,yosys_json(d,custom_skin=True))


def test_mux_trapezoid_taper_and_select_anchor():
    from cdiag.skin import _layout_of
    d=parse('version 1 diagram "t" { m: MUX(width=32) }')
    block=d.blocks['m']
    assert block.ports['S'].side == 'south'
    w,h,_=_layout_of(block)
    shape=locate(root_of(generate_skin(d)), 'cdiag_m')
    path=next(x for x in shape if x.tag=='{%s}path'%SVG).attrib['d']
    import re
    numbers=list(map(float,re.findall(r'(?<![A-Za-z])[0-9]+(?:\.[0-9]+)?',path)))
    # M 0,0 L W,low L W,high L 0,H Z. The narrow output
    # edge must be much shorter than the input edge.
    assert len(numbers)==8
    assert numbers[2]==w and numbers[4]==w
    assert (numbers[5]-numbers[3]) / h < 0.30
    ax,ay=anchors(shape)['S']
    assert 0<ax<w and 0<ay<h
    assert ay==pytest.approx(h - (1-0.23)/2*h*(ax/w), abs=.03)


def test_alu_has_concave_notch_and_non_rectangular_outline():
    from cdiag.skin import _layout_of
    d=parse('version 1 diagram "t" { u: ALU(width=32) }')
    block=d.blocks['u']
    assert block.ports['OP'].side == 'north'
    shape=locate(root_of(generate_skin(d)), 'cdiag_u')
    import re
    path=next(x for x in shape if x.tag=='{%s}path'%SVG).attrib['d']
    numbers=list(map(float,re.findall(r'(?<![A-Za-z])[0-9]+(?:\.[0-9]+)?',path)))
    w,h,_=_layout_of(block)
    # The concave apex must be inside the left side, at the vertical midpoint.
    assert len(numbers)==14
    assert numbers[10] > 0 and numbers[10] < w*.3
    assert numbers[11]==pytest.approx(h*.5)
    assert anchors(shape)['OP'][1] > 0
    assert anchors(shape)['Y'][0] == w


def test_sram_is_plain_rectangle_without_internal_decorative_paths():
    d=parse('version 1 diagram "t" { m: SRAM(width=64) }')
    shape=locate(root_of(generate_skin(d)),'cdiag_m')
    direct=[x for x in shape if x.tag.startswith('{%s}'%SVG)]
    assert sum(x.tag=='{%s}rect'%SVG for x in direct)==1
    assert not any(x.tag in ('{%s}path'%SVG,'{%s}line'%SVG) for x in direct)


def test_issue_scheduler_is_not_builtin():
    d=parse('version 1 diagram "t" { iq: box "Issue Scheduler" { in READY out ISSUE } }')
    assert not d.blocks['iq'].builtin
    from cdiag.symbols import builtin
    assert builtin('IssueScheduler',{}) is None
