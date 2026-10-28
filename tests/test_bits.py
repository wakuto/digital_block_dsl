"""LSB-first Yosys bit ordering, full/partial slices, and circle templates."""
from pathlib import Path
import math
import xml.etree.ElementTree as ET
import pytest
from cdiag.parser import parse, parse_file
from cdiag.backends import yosys_json, write_bundle, to_dot, render_graphviz
from cdiag.model import DiagramError
from cdiag.skin import generate_skin, S, SVG

ROOT = Path(__file__).resolve().parents[1]

def fail(source, code):
    with pytest.raises(DiagramError) as ex:
        parse(source)
    assert ex.value.code == code


def test_concat_is_msb_first_and_yosys_lsb_first():
    d = parse('''version 1 diagram "concat" {
        input hi[8], lo[8] output bus[16]
        {hi, lo} -> bus
    }''')
    m = yosys_json(d)['modules']['top']['ports']
    assert m['bus']['bits'] == m['lo']['bits'] + m['hi']['bits']
    assert len(set(m['bus']['bits'])) == 16


def test_split_and_select_keep_exact_bit_ids():
    d = parse('''version 1 diagram "split" {
        input bus[32]
        output hi[16], lo[8], one[1]
        bus[31:16] -> hi
        bus[7:0] -> lo
        bus[7] -> one
    }''')
    m = yosys_json(d)['modules']['top']['ports']
    assert m['hi']['bits'] == m['bus']['bits'][16:32]
    assert m['lo']['bits'] == m['bus']['bits'][0:8]
    assert m['one']['bits'] == m['bus']['bits'][7:8]


def test_partial_port_destination_and_concat_from_block():
    d = parse_file(ROOT/'examples'/'concat_into_ports.cdl')
    m = yosys_json(d, custom_skin=True)['modules']['top']
    ports = m['ports']; cells = m['cells']
    bits = cells['decoder']['connections']['INSTR']
    assert bits[0:8] == ports['imm']['bits']
    assert bits[8:12] == ports['flags']['bits']
    assert bits[12:16] == ports['opcode']['bits']
    assert cells['register']['connections']['D'] == (
        cells['decoder']['connections']['IMM'] + cells['decoder']['connections']['OPCODE'])
    assert ports['op_high']['bits'] == cells['register']['connections']['Q'][8:16]
    assert ports['op_low']['bits'] == cells['register']['connections']['Q'][0:8]


def test_concat_infers_one_unsized_source_and_unknown_sink():
    d = parse('''version 1 diagram "infer" {
        input top[4], low
        output result[10]
        {top, low} -> result
    }''')
    assert d.ports['low'].width == 6
    m = yosys_json(d)['modules']['top']['ports']
    assert m['result']['bits'] == m['low']['bits'] + m['top']['bits']


def test_sliced_input_requires_declared_width():
    fail('version 1 diagram "x" {input a output b[3] a[2:0] -> b}', 'E207')


def test_out_of_range_and_reversed_selection():
    fail('version 1 diagram "x" {input a[8] output b[8] a[8:1] -> b}', 'E206')
    fail('version 1 diagram "x" {input a[8] output b[8] a[0:7] -> b}', 'E206')


def test_invalid_concat_width_and_ambiguous_width():
    fail('version 1 diagram "x" {input a[8], b[8] output c[15] {a,b} -> c}', 'E204')
    fail('version 1 diagram "x" {input a, b output c[16] {a,b} -> c}', 'E207')


def test_partial_overlap_detects_double_driver_but_nonoverlap_passes():
    fail('''version 1 diagram "x" {
        input a[8], b[4] output c[16]
        a -> c[7:0]
        b -> c[5:2]
    }''', 'E105')
    d = parse('''version 1 diagram "x" {
        input a[8], b[8] output c[16]
        a -> c[15:8]
        b -> c[7:0]
    }''')
    m = yosys_json(d)['modules']['top']['ports']
    assert m['c']['bits'] == m['b']['bits'] + m['a']['bits']


def test_named_concat_has_correct_bus_bits():
    d = parse('''version 1 diagram "x" {
        input a[2], b[3] output c[5]
        net combo[5] = {a,b} -> c
    }''')
    m = yosys_json(d)['modules']['top']
    assert m['netnames']['combo']['bits'] == m['ports']['c']['bits']


def test_shift_amount_width():
    d = parse('''version 1 diagram "x" {
        input a[32], shamt[5] output y[32]
        s: SHR(width=32) a -> s.A shamt -> s.B s.Y -> y
    }''')
    assert d.blocks['s'].ports['B'].width == 5
    d = parse('version 1 diagram "x" { s: SAR(width=64, shamt_width=7) }')
    assert d.blocks['s'].ports['B'].width == 7
    fail('version 1 diagram "x" { s: SHIFT(width=16, shamt_width=0) }', 'E202')


def test_arithmetic_skins_are_compact_rounded_rectangles():
    d = parse('''version 1 diagram "shapes" {
        a: ADD(width=32)
        b: SUB(width=32)
        c: CMP(width=32)
        d: SHIFT(width=32)
        e: SHL(width=32)
        f: SHR(width=32)
        g: SAR(width=32)
    }''')
    root = ET.fromstring(generate_skin(d))
    for bid in 'abcdefg':
        elem = next(n for n in root.iter() if n.attrib.get('{'+S+'}type')=='cdiag_'+bid)
        rect = next(ch for ch in elem if ch.tag == '{'+SVG+'}rect')
        assert float(rect.get('rx')) >= 7
        w=float(rect.get('width'));h=float(rect.get('height'))
        assert w <= 90 and h <= 60, (bid, w, h)
        assert not any(ch.tag == '{'+SVG+'}circle' for ch in elem)
        ports = [n for n in elem.iter() if n.get('{'+S+'}pid')]
        assert len(ports) >= 3
        for port in ports:
            x=float(port.get('{'+S+'}x'));y=float(port.get('{'+S+'}y'))
            assert 0<=x<=w and 0<=y<=h
            assert math.isclose(x,0,abs_tol=.01) or math.isclose(x,w,abs_tol=.01) or \
                   math.isclose(y,0,abs_tol=.01) or math.isclose(y,h,abs_tol=.01)

def test_bit_example_can_bundle_and_preview(tmp_path):
    d = parse_file(ROOT/'examples'/'bit_manipulation.cdl')
    base = tmp_path/'bit_diagram'
    netlist, skin = write_bundle(d, base)
    assert netlist.is_file() and skin.is_file()
    assert 'CDL__shift' in netlist.read_text()
    assert 'rx="9"' in skin.read_text()
    svg = tmp_path/'preview.svg'
    render_graphviz(d, svg)
    assert svg.exists()
    assert 'CONCAT' in to_dot(d)


def test_unsized_slice_is_illegal_regardless_of_statement_order():
    base = '''version 1 diagram "order" {
        input a
        output c[8], d[16]
        WIRINGS
    }'''
    for lines in ['a -> d\na[7:0] -> c', 'a[7:0] -> c\na -> d']:
        fail(base.replace('WIRINGS', lines), 'E207')
