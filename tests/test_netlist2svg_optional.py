"""Run true ELK/SVG integration when netlist2svg is installed on the host."""
import shutil
from pathlib import Path
import xml.etree.ElementTree as ET
import pytest
from cdiag.backends import render_netlist2svg
from cdiag.parser import parse_file

ROOT=Path(__file__).resolve().parents[1]

@pytest.mark.skipif(shutil.which('netlist2svg') is None,reason='npm netlist2svg is not installed')
@pytest.mark.parametrize('name',['execution','memory_pipeline','scheduler','complex_feedback','bit_manipulation','concat_into_ports'])
def test_real_netlist2svg(tmp_path,name):
    d=parse_file(ROOT/'examples'/f'{name}.cdl')
    target=tmp_path/(name+'.svg')
    render_netlist2svg(d,target)
    root=ET.parse(target).getroot()
    assert root.tag.endswith('svg')
    assert target.stat().st_size>500
    assert 'cell_' in target.read_text()
    if any(n.name for n in d.nets) and d.netlabels:
        assert 'cdiag-net-label' in target.read_text()
