import json
from pathlib import Path
import pytest
from cdiag.model import DiagramError
from cdiag.parser import parse, parse_file
from cdiag.backends import yosys_json, to_dot, render_graphviz
from cdiag.cli import main

ROOT = Path(__file__).parents[1]
EXAMPLE = (ROOT / "examples/execution.cdl").read_text()


def fail(source, code):
    with pytest.raises(DiagramError) as ex:
        parse(source)
    assert ex.value.code == code


def test_sample():
    diagram = parse(EXAMPLE)
    assert len(diagram.blocks) == 4
    assert diagram.blocks["mem"].ports["CLK"].side == "north"
    net = next(n for n in diagram.nets if n.driver == "reg0.Q")
    assert net.width == 32 and net.name == "writeback"
    assert net.sinks == ["mem.WDATA", "result"]


def test_second_example():
    d = parse_file(ROOT / "examples/memory_pipeline.cdl")
    assert len(d.blocks) == 6
    assert next(n for n in d.nets if n.driver == "clk").sinks == ["addr_reg.CLK", "mem.CLK", "ctrl.CLK"]


def test_grammar_all_features():
    s = '''version 1 diagram "x" { direction RL input src[8] output dst[8]
    node: box "Generic" { in A[8]@north out Q[8]@south }
    src -> node.A net value[8] = node.Q -> dst
    }'''
    d = parse(s)
    assert d.direction == "RL"
    assert d.blocks["node"].ports["A"].side == "north"
    assert d.nets[1].name == "value"


def test_unknown_ref():
    fail(EXAMPLE.replace("reg0.CLK", "reg0.BAD"), "E101")


def test_width_error():
    fail(EXAMPLE.replace("a[32]", "a[64]"), "E204")


def test_input_as_source_error():
    fail(EXAMPLE.replace("a -> add0.A", "add0.A -> a"), "E103")


def test_multiple_drivers_error():
    fail(EXAMPLE.replace("b -> add0.B", "b -> add0.A"), "E105")


def test_duplicate_block_error():
    fail(EXAMPLE.replace("mux0: MUX(width=32)", "add0: MUX(width=32)"), "E102")


def test_zero_width_error():
    fail(EXAMPLE.replace("a[32]", "a[0]"), "E201")


def test_unknown_builtin_parameter():
    fail(EXAMPLE.replace("add0: ADD(width=32)", "add0: ADD(bogus=1)"), "E202")


def test_unknown_type_without_ports():
    fail(EXAMPLE.replace("add0: ADD(width=32)", "add0: MAGIC"), "E203")


def test_syntax_error():
    fail(EXAMPLE.replace("diagram \"Execution Datapath\" {", "diagram {"), "E001")


def test_version_error():
    fail(EXAMPLE.replace("version 1", "version 2"), "E002")


def test_duplicated_net_label_error():
    fail(EXAMPLE.replace("net writeback[32] = reg0.Q -> mem.WDATA, result", "net label[32] = reg0.Q -> result\n net label[32] = add0.Y -> mux0.A"), "E104")


def test_unnamed_width_and_fanout():
    s = '''version 1 diagram "t" {
    input a
    output b[8], c[8]
    a -> b, c
    }'''
    d = parse(s)
    assert d.nets[0].width == 8
    n = yosys_json(d)["modules"]["top"]["ports"]
    assert n["a"]["bits"] == n["b"]["bits"] == n["c"]["bits"]
    assert len(n["a"]["bits"]) == 8


def test_two_nets_have_different_bits():
    n = yosys_json(parse(EXAMPLE))["modules"]["top"]
    assert n["ports"]["a"]["bits"] != n["ports"]["b"]["bits"]
    assert n["cells"]["add0"]["connections"]["A"] == n["ports"]["a"]["bits"]


def test_netlist_schema():
    n = yosys_json(parse(EXAMPLE))
    assert n["modules"]["top"]["cells"]["mux0"]["type"] == "$mux"
    assert n["modules"]["top"]["cells"]["mem"]["type"] == "Data SRAM"
    assert "writeback" in n["modules"]["top"]["netnames"]
    json.dumps(n)


def test_dot_contains_port_anchors():
    dot = to_dot(parse(EXAMPLE))
    assert 'PORT="p0"' in dot and "b_add0:p0" in dot


def test_svg_integration(tmp_path):
    out = tmp_path / "result.svg"
    render_graphviz(parse(EXAMPLE), out)
    text = out.read_text()
    assert '<svg ' in text and 'Data SRAM' in text


def test_cli(tmp_path, capsys):
    assert main(["check", str(ROOT / "examples/execution.cdl")]) == 0
    assert "OK:" in capsys.readouterr().out
    assert main(["dump-ir", str(ROOT / "examples/execution.cdl"), "-o", str(tmp_path / "ir.json")]) == 0
    assert json.loads((tmp_path / "ir.json").read_text())["blocks"]["add0"]["type"] == "ADD"
    assert main(["render", str(ROOT / "examples/execution.cdl"), "-o", str(tmp_path / "out.svg")]) == 0


def test_netlist2svg_absent_error(tmp_path, monkeypatch):
    import cdiag.backends as b
    monkeypatch.setattr(b.shutil, "which", lambda name: None if name == "netlist2svg" else "/usr/bin/dot")
    with pytest.raises(DiagramError, match="netlist2svg not found"):
        b.render_netlist2svg(parse(EXAMPLE), tmp_path / "f.svg")
