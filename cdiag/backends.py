"""Graphviz preview and Yosys-JSON / Netlist2SVG output backends."""
from __future__ import annotations
import html
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from .model import Diagram, DiagramError


# Yosys primitive names recognized by Netlist2SVG's standard digital skin.
SKIN_TYPES = {
    "ADD": "$add", "SUB": "$sub", "MUX": "$mux", "DFF": "$dff",
    "CMP": "$eq", "SHIFT": "$shl", "SHL": "$shl", "SHR": "$shr", "SAR": "$sshr", "AND": "$and", "OR": "$or", "NOT": "$not", "XOR": "$xor"
}


def yosys_json(diagram: Diagram, custom_skin: bool = False) -> dict:
    """Serialize a visualization netlist, with no synthesis or Yosys dependency."""
    # Assign a distinct vector to each endpoint, then unify only the selected
    # bit positions. Yosys/Netlist2SVG interprets these vectors LSB-first and
    # automatically inserts split/join display nodes when needed.
    endpoint_nodes = {}
    parent = {}
    for name, port in diagram.ports.items():
        for index in range(port.width or 1):
            node = (name, index)
            parent[node] = node
        endpoint_nodes[name] = [(name, i) for i in range(port.width or 1)]
    for bid, block in diagram.blocks.items():
        for pn, port in block.ports.items():
            ep = f"{bid}.{pn}"
            endpoint_nodes[ep] = [(ep, i) for i in range(port.width or 1)]
            for node in endpoint_nodes[ep]:
                parent[node] = node

    def root(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a, b):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[rb] = ra

    def selected(ref):
        bits = endpoint_nodes[ref.endpoint]
        return bits if ref.msb is None else bits[ref.lsb:ref.msb+1]

    for wiring in diagram.wirings:
        source_bits = []
        for source in reversed(wiring.sources):
            source_bits.extend(selected(source))
        for sink in wiring.sinks:
            dest_bits = selected(sink)
            if len(source_bits) != len(dest_bits):
                raise DiagramError("E204", "inconsistent connection length in backend", wiring.line)
            for a, b in zip(source_bits, dest_bits):
                union(a, b)

    ids = {}
    next_bit = 2
    endpoint_bits = {}
    for ep, nodes in endpoint_nodes.items():
        result = []
        for node in nodes:
            rep = root(node)
            if rep not in ids:
                ids[rep] = next_bit
                next_bit += 1
            result.append(ids[rep])
        endpoint_bits[ep] = result
    netnames = {}
    for wiring in diagram.wirings:
        if wiring.name:
            bits = []
            for source in reversed(wiring.sources):
                bits.extend(endpoint_bits[source.endpoint][source.lsb:source.msb+1]
                            if source.msb is not None else endpoint_bits[source.endpoint])
            old = netnames.get(wiring.name)
            if old is not None and old["bits"] != bits:
                raise DiagramError("E104", f"conflicting named net {wiring.name!r}")
            netnames[wiring.name] = {"hide_name": 0, "bits": bits, "attributes": {}}

    def bits_for(endpoint, width):
        return endpoint_bits[endpoint]

    ports = {}
    for name, port in diagram.ports.items():
        ports[name] = {"direction": port.direction, "bits": bits_for(name, port.width)}

    cells = {}
    for id_, block in diagram.blocks.items():
        connections = {}
        port_directions = {}
        for pn, port in block.ports.items():
            key = f"{id_}.{pn}"
            connections[pn] = bits_for(key, port.width)
            port_directions[pn] = port.direction
        cell = {
            "hide_name": 0,
            "type": ("CDL__" + id_) if custom_skin else SKIN_TYPES.get(block.type, block.label if block.type == "box" else block.type),
            "parameters": {},
            "attributes": {"name": block.label},
            "port_directions": port_directions,
            "connections": connections,
        }
        if not custom_skin and block.type in {"MUX", "DFF"}:
            cell["parameters"]["WIDTH"] = block.params.get("width", 32)
        cells[id_] = cell
    return {"creator": "cdiag 0.4", "modules": {
        "top": {"attributes": {"top": 1}, "ports": ports,
                "cells": cells, "netnames": netnames}
    }}


def _safe(s):
    return html.escape(str(s), quote=True)


def _port_title(port):
    return _safe(port.name + (f" [{port.width}]" if port.width is not None else ""))


def _block_label(block, palette=None):
    """Graphviz HTML table with individually addressable port anchors."""
    groups = {side: [] for side in ("west", "east", "north", "south")}
    for idx, p in enumerate(block.ports.values()):
        side = p.side or ("west" if p.direction == "input" else "east")
        groups[side].append((idx, p))
    def tag(idx, p, colspan=1):
        return (f'<TD PORT="p{idx}" COLSPAN="{colspan}" CELLPADDING="5" '
                f'BGCOLOR="#F6F9FD"><FONT POINT-SIZE="10" COLOR="#334155">'
                f'{_port_title(p)}</FONT></TD>')
    if palette is None:
        from .skin import PALETTES
        palette=PALETTES['light']
    style = block.style or ('logic' if block.type in {"ALU", "ADD", "SUB", "CMP", "AND", "OR", "XOR", "NOT"} else 'storage' if block.type in {"DFF", "SRAM"} else 'control' if block.type in {'MUX'} else 'neutral')
    bg = palette.get(style,palette['neutral'])
    rows = [f'<TR><TD COLSPAN="3" BGCOLOR="{bg}" CELLPADDING="9"><FONT COLOR="#19283F" POINT-SIZE="13"><B>{_safe(block.label)}</B></FONT></TD></TR>']
    for idx,p in groups["north"]:
        rows.append(f"<TR>{tag(idx,p,3)}</TR>")
    w,e=groups["west"],groups["east"]
    for i in range(max(len(w), len(e), 1)):
        a = tag(*w[i]) if i < len(w) else '<TD BGCOLOR="#FFFFFF"></TD>'
        z = tag(*e[i]) if i < len(e) else '<TD BGCOLOR="#FFFFFF"></TD>'
        center = '<TD WIDTH="26" BGCOLOR="#FFFFFF"></TD>'
        rows.append(f"<TR>{a}{center}{z}</TR>")
    for idx,p in groups["south"]:
        rows.append(f"<TR>{tag(idx,p,3)}</TR>")
    return '<TABLE BORDER="1" COLOR="#94A3B8" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0">' + ''.join(rows) + '</TABLE>'


def to_dot(diagram: Diagram, ortho: bool = True) -> str:
    try:
        from graphviz import Digraph
    except ImportError as e:
        raise DiagramError("E301", "Graphviz Python package required: pip install graphviz") from e
    from .skin import PALETTES, PRESETS
    palette=PALETTES[diagram.theme]
    layout=PRESETS[diagram.layout]
    g = Digraph("CDL", graph_attr={"rankdir": diagram.direction, "bgcolor": palette['paper'],
           "label": diagram.title, "labelloc": "t", "fontsize": "18", "fontname": "DejaVu Sans",
           "nodesep": str(layout['nodes']/60), "ranksep": str(layout['layers']/45), "pad": "0.3",
           "splines": "ortho" if ortho else "polyline", "outputorder": "edgesfirst"},
           edge_attr={"color": "#54677E", "penwidth": "1.5", "arrowsize": "0.55", "fontname": "DejaVu Sans"},
           node_attr={"fontname": "DejaVu Sans"})
    for pn, p in diagram.ports.items():
        g.node("top_" + pn, label=pn + (f" [{p.width}]" if p.width is not None else ""),
               shape="box", style="rounded,filled", fillcolor="#F1F5F9", color="#CBD5E1",
               fontsize="10", margin="0.12,0.08")
    for bid, b in diagram.blocks.items():
        g.node("b_" + bid, label="<" + _block_label(b, palette) + ">", shape="plain")
    def anchor(ep):
        if "." in ep:
            b, p = ep.split(".")
            ports = list(diagram.blocks[b].ports)
            return f"b_{b}:p{ports.index(p)}"
        return "top_" + ep
    for wi, wiring in enumerate(diagram.wirings):
        if len(wiring.sources) == 1:
            src = wiring.sources[0]
            for i, sink in enumerate(wiring.sinks):
                attrs = {}
                if src.msb is not None or sink.msb is not None:
                    attrs["xlabel"] = f"{str(src)} -> {str(sink)}"
                    attrs["fontsize"] = "9"
                elif diagram.netlabels and wiring.name and i == 0:
                    attrs["xlabel"] = wiring.name
                    attrs["fontcolor"] = "#475569"
                    attrs["fontsize"] = "9"
                g.edge(anchor(src.endpoint), anchor(sink.endpoint), **attrs)
        else:
            # Preview-only abstraction: the final Netlist2SVG backend performs
            # correct bit-level concatenation without a hardware concat cell.
            cid = f"cdiag_concat_{wi}"
            g.node(cid, label="CONCAT", shape="box", style="rounded,filled",
                   fillcolor="#E7F0FC", fontsize="10")
            for part in wiring.sources:
                g.edge(anchor(part.endpoint), cid, xlabel=str(part), fontsize="9")
            for sink in wiring.sinks:
                g.edge(cid, anchor(sink.endpoint), xlabel=str(sink), fontsize="9")
    return g.source


def render_graphviz(diagram: Diagram, output: str | Path, ortho: bool = True):
    if not shutil.which("dot"):
        raise DiagramError("E301", "Graphviz 'dot' executable not found; install graphviz")
    content = to_dot(diagram, ortho)
    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(["dot", "-Tsvg", "-o", str(out)], input=content,
                              capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired as e:
        raise DiagramError("E302", "Graphviz layout timed out") from e
    if proc.returncode != 0 or not out.exists():
        raise DiagramError("E302", f"Graphviz failed: {proc.stderr.strip()}")
    return out


def write_bundle(diagram: Diagram, base_path: str | Path, theme=None, layout=None):
    """Write mutually consistent netlist and generated SVG skin for offline use."""
    from .skin import generate_skin
    base = Path(base_path)
    base.parent.mkdir(parents=True, exist_ok=True)
    netlist_path=Path(str(base)+".json")
    skin_path=Path(str(base)+".skin.svg")
    netlist_path.write_text(json.dumps(yosys_json(diagram,custom_skin=True), ensure_ascii=False, indent=2)+"\n",encoding="utf-8")
    skin_path.write_text(generate_skin(diagram,theme=theme,layout=layout),encoding="utf-8")
    return netlist_path,skin_path


def render_netlist2svg(diagram: Diagram, output: str | Path, skin: str | None = None, *, theme=None, layout=None):
    if not shutil.which("netlist2svg"):
        raise DiagramError("E303", "netlist2svg not found; use cdiag bundle and run netlist2svg on your PC")
    from .skin import generate_skin
    from .svg_labels import annotate
    with tempfile.TemporaryDirectory(prefix="cdiag_") as tempdir:
        inp = Path(tempdir) / "diagram.json"
        skinfile = Path(tempdir) / "diagram.skin.svg"
        model = yosys_json(diagram, custom_skin=(skin is None))
        inp.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
        if skin is None:
            skinfile.write_text(generate_skin(diagram,theme,layout),encoding="utf-8")
            skin = str(skinfile)
        out = Path(output).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["netlist2svg", str(inp), "-o", str(out), "--skin", str(Path(skin).resolve())]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        except subprocess.TimeoutExpired as e:
            raise DiagramError("E305", "netlist2svg timed out") from e
        if proc.returncode != 0 or not out.exists():
            raise DiagramError("E305", f"netlist2svg failed: {(proc.stderr or proc.stdout).strip()}")
        if diagram.netlabels:
            label_model = model
            if theme: diagram.theme=theme
            annotate(out,diagram,label_model)
        return out
