"""Lark AST parsing plus semantic checks and width inference."""
import json
from pathlib import Path
from lark import Lark, Token, Tree, UnexpectedInput
from .model import Diagram, Block, Port, Net, SignalRef, Wiring, DiagramError
from .symbols import builtin

_GRAMMAR = (Path(__file__).parent / "grammar.lark").read_text(encoding="utf-8")
PARSER = Lark(_GRAMMAR, parser="lalr", propagate_positions=True)


def unquote(tok):
    return json.loads(str(tok))


def parse_port(t: Tree, direction: str) -> Port:
    name = str(t.children[0])
    width = None
    side = None
    for n in t.children[1:]:
        if n.data == "width":
            width = int(n.children[0])
        elif n.data == "port_side":
            side = str(n.children[0])
    if width == 0:
        raise DiagramError("E201", f"port {name} width must be positive", t.meta.line)
    return Port(name, direction, width, side, t.meta.line)


def parse_ports(t: Tree, direction: str) -> dict[str, Port]:
    ports = {}
    for child in t.children:
        p = parse_port(child, direction)
        if p.name in ports:
            raise DiagramError("E102", f"duplicate port {p.name!r}", p.line)
        ports[p.name] = p
    return ports


def parse_parameter(t: Tree):
    k, v = str(t.children[0]), t.children[1]
    if v.data == "int_value":
        return k, int(v.children[0])
    if v.data == "string_value":
        return k, unquote(v.children[0])
    return k, str(v.children[0])


def endpoint(t: Tree) -> str:
    return ".".join(str(ch) for ch in t.children)


def signal_ref(t: Tree) -> SignalRef:
    ep = endpoint(t.children[0])
    if len(t.children) == 1:
        return SignalRef(ep)
    sel = t.children[1]
    hi = int(sel.children[0])
    lo = int(sel.children[1]) if len(sel.children) == 2 else hi
    if hi < lo:
        raise DiagramError("E206", f"reversed bit selection {ep}[{hi}:{lo}]; use [msb:lsb]", t.meta.line)
    return SignalRef(ep, hi, lo)


def source_expr(t: Tree) -> list[SignalRef]:
    if t.data == "concat_expr":
        return [signal_ref(p) for p in t.children]
    return [signal_ref(t)]


def _ref_width(d: Diagram, ref: SignalRef, line: int) -> int | None:
    p = _get_reference(d, ref.endpoint, line)
    if ref.msb is not None:
        if p.width is None:
            raise DiagramError("E207", f"slice {ref} requires an explicitly sized port", line)
        if ref.msb >= p.width:
            raise DiagramError("E206", f"slice {ref} is outside {p.width}-bit port", line)
        return ref.msb - ref.lsb + 1
    return p.width


def _set_ref_width(d: Diagram, ref: SignalRef, width: int, line: int):
    if width < 1:
        raise DiagramError("E204", f"invalid inferred width {width} for {ref}", line)
    if ref.msb is not None:
        if _ref_width(d, ref, line) != width:
            raise DiagramError("E204", f"width mismatch on selected port {ref}", line)
        return False
    port = _get_reference(d, ref.endpoint, line)
    if port.width is not None and port.width != width:
        raise DiagramError("E204", f"width mismatch: {ref} has {port.width} bits, expected {width}", line)
    if port.width is None:
        port.width = width
        return True
    return False


def _resolve_wirings(d: Diagram):
    """Infer widths and verify each destination bit has at most one driver."""
    for wiring in d.wirings:
        for src in wiring.sources:
            _get_reference(d, src.endpoint, wiring.line)
            if _role(d, src.endpoint) != "source":
                raise DiagramError("E103", f"{src} cannot drive a net", wiring.line)
        for sink in wiring.sinks:
            _get_reference(d, sink.endpoint, wiring.line)
            if _role(d, sink.endpoint) != "sink":
                raise DiagramError("E103", f"{sink} cannot receive a net", wiring.line)
    # Slices must refer to explicitly sized ports. Check this before the fixed
    # point, so source declaration order cannot change which files are valid.
    for wiring in d.wirings:
        for ref in [*wiring.sources, *wiring.sinks]:
            if ref.msb is not None and _get_reference(d, ref.endpoint, wiring.line).width is None:
                raise DiagramError("E207", f"slice {ref} requires an explicitly sized port", wiring.line)
    # Fixed point: propagate widths along buses, including through fanout and
    # through a concat with exactly one unsized component.
    for _ in range(max(2, len(d.wirings) * 3 + 1)):
        changed = False
        for w in d.wirings:
            src_widths = [_ref_width(d, src, w.line) for src in w.sources]
            sink_widths = [_ref_width(d, sink, w.line) for sink in w.sinks]
            available = [v for v in [w.width, *sink_widths] if v is not None]
            if len(w.sources) == 1 and src_widths[0] is not None:
                available.append(src_widths[0])
            if len(set(available)) > 1:
                raise DiagramError("E204", f"width mismatch in connection at line {w.line}: {sorted(set(available))}", w.line)
            target = available[0] if available else None
            if all(v is not None for v in src_widths):
                joined = sum(src_widths)
                if target is not None and joined != target:
                    raise DiagramError("E204", f"concat/connection width {joined} does not match {target}", w.line)
                target = joined
            if target is None:
                continue
            for sink in w.sinks:
                changed |= _set_ref_width(d, sink, target, w.line)
            missing = [i for i, v in enumerate(src_widths) if v is None]
            if len(missing) == 1:
                remainder = target - sum(v for v in src_widths if v is not None)
                changed |= _set_ref_width(d, w.sources[missing[0]], remainder, w.line)
        if not changed:
            break
    # Final check, also rejects ambiguous unsized concatenations.
    owners: dict[tuple[str, int], tuple[str, int]] = {}
    nets: dict[str, Net] = {}
    names: dict[str, str] = {}
    for w in d.wirings:
        widths = [_ref_width(d, src, w.line) for src in w.sources]
        if len(w.sources) > 1 and any(width is None for width in widths):
            raise DiagramError("E207", "cannot infer concat component widths; declare widths on source ports", w.line)
        source_width = sum(v or 1 for v in widths)
        if w.width is not None and w.width != source_width:
            raise DiagramError("E204", f"named net {w.name!r}: expected {w.width} bits, received {source_width}", w.line)
        w.width = source_width
        for sink in w.sinks:
            sink_width = _ref_width(d, sink, w.line) or 1
            if sink_width != source_width:
                raise DiagramError("E204", f"width mismatch: {source_width}-bit source to {sink} ({sink_width} bits)", w.line)
        # Concat sources are listed most-significant first. Bits are indexed LSB first.
        source_bits = []
        for src, width in reversed(list(zip(w.sources, widths))):
            lo = src.lsb if src.lsb is not None else 0
            source_bits.extend((src.endpoint, k) for k in range(lo, lo + (width or 1)))
        for sink in w.sinks:
            lo = sink.lsb if sink.lsb is not None else 0
            for index, source_bit in enumerate(source_bits):
                dest = sink.endpoint, lo + index
                if dest in owners and owners[dest] != source_bit:
                    raise DiagramError("E105", f"{sink} bit {lo + index} has multiple drivers", w.line)
                owners[dest] = source_bit
        if w.name is not None:
            key = ','.join(f'{ep}:{idx}' for ep, idx in source_bits)
            if w.name in names and names[w.name] != key:
                raise DiagramError("E104", f"net name {w.name!r} assigned to distinct nets", w.line)
            names[w.name] = key
        if len(w.sources) == 1 and w.sources[0].msb is None and all(s.msb is None for s in w.sinks):
            ep = w.sources[0].endpoint
            if ep not in nets:
                nets[ep] = Net(ep, [], w.width, w.name, w.line)
            n = nets[ep]
            if n.name and w.name and n.name != w.name:
                raise DiagramError("E104", f"conflicting names on {ep}", w.line)
            if w.name:
                n.name = w.name
            if n.width != w.width:
                raise DiagramError("E204", f"width mismatch on {ep}", w.line)
            for sink in w.sinks:
                if sink.endpoint not in n.sinks:
                    n.sinks.append(sink.endpoint)
    d.nets = list(nets.values())


def _get_reference(d: Diagram, ep: str, line: int) -> Port:
    parts = ep.split(".")
    if len(parts) == 1:
        if ep not in d.ports:
            raise DiagramError("E101", f"unknown diagram port {ep!r}", line)
        return d.ports[ep]
    inst, pin = parts
    if inst not in d.blocks:
        raise DiagramError("E101", f"unknown block {inst!r}", line)
    b = d.blocks[inst]
    if pin not in b.ports:
        raise DiagramError("E101", f"unknown port {ep!r}; available: {', '.join(b.ports)}", line)
    return b.ports[pin]


def _role(d: Diagram, ep: str) -> str:
    p = _get_reference(d, ep, 0)
    # Top input drives nets; top output receives nets.
    if "." not in ep:
        return "source" if p.direction == "input" else "sink"
    return "source" if p.direction == "output" else "sink"


def parse(text: str) -> Diagram:
    try:
        tree = PARSER.parse(text)
    except UnexpectedInput as e:
        message = e.get_context(text, span=30).strip()
        raise DiagramError("E001", f"syntax error: {message}", e.line, e.column) from e
    version = tree.children[0]
    if int(version.children[0]) != 1:
        raise DiagramError("E002", "only version 1 is supported", version.meta.line)
    node = tree.children[1]
    diagram = Diagram(unquote(node.children[0]))
    connection_decls = []
    for stmt in node.children[1:]:
        if stmt.data == "direction_decl":
            diagram.direction = str(stmt.children[0])
        elif stmt.data == "theme_decl":
            diagram.theme = str(stmt.children[0])
        elif stmt.data == "layout_decl":
            diagram.layout = str(stmt.children[0])
        elif stmt.data == "netlabels_decl":
            diagram.netlabels = str(stmt.children[0]) == "on"
        elif stmt.data == "top_ports":
            direction = str(stmt.children[0])
            pp = parse_ports(stmt.children[1], direction)
            for name, p in pp.items():
                if name in diagram.ports or name in diagram.blocks:
                    raise DiagramError("E102", f"duplicate identifier {name!r}", p.line)
                diagram.ports[name] = p
        elif stmt.data == "block_decl":
            bid = str(stmt.children[0])
            if bid in diagram.blocks or bid in diagram.ports:
                raise DiagramError("E102", f"duplicate identifier {bid!r}", stmt.meta.line)
            kindnode = stmt.children[1]
            if kindnode.data == "box_kind":
                kind, label, params = "box", unquote(kindnode.children[0]), {}
            else:
                kind = str(kindnode.children[0]); label = kind; params = {}
                if len(kindnode.children) > 1:
                    for par in kindnode.children[1].children:
                        k, v = parse_parameter(par)
                        if k in params:
                            raise DiagramError("E102", f"duplicate parameter {k!r}", par.meta.line)
                        params[k] = v
            try:
                preset = builtin(kind, params)
            except ValueError as e:
                raise DiagramError("E202", str(e), stmt.meta.line) from e
            ports = preset or {}
            block = Block(bid, kind, label, ports, params, stmt.meta.line, preset is not None)
            if len(stmt.children) > 2:
                body = stmt.children[2]
                for declaration in body.children:
                    if declaration.data == "style_decl":
                        block.style = str(declaration.children[0])
                        continue
                    if declaration.data == "label_decl":
                        block.label = unquote(declaration.children[0])
                        continue
                    direction = "input" if str(declaration.children[0]) == "in" else "output"
                    extra = parse_ports(declaration.children[1], direction)
                    for name, p in extra.items():
                        if name in ports:
                            # For builtin: side overrides allowed. Width can only repeat same inferred value.
                            old = ports[name]
                            if not block.builtin or old.direction != p.direction or (p.width is not None and p.width != old.width):
                                raise DiagramError("E102", f"incompatible duplicate port {bid}.{name}", p.line)
                            if p.side:
                                old.side = p.side
                        else:
                            if block.builtin:
                                raise DiagramError("E102", f"cannot add port {name!r} to builtin {kind}", p.line)
                            ports[name] = p
            if not ports:
                raise DiagramError("E203", f"{bid} has no ports; declare them using a block body", stmt.meta.line)
            diagram.blocks[bid] = block
        elif stmt.data in {"connection_decl", "net_decl"}:
            connection_decls.append(stmt)
    # Resolve connections in a second pass, after all blocks and ports exist.
    for stmt in connection_decls:
        named = stmt.data == "net_decl"
        offset = 0
        name = None
        width = None
        if named:
            name = str(stmt.children[0])
            offset = 1
            if isinstance(stmt.children[1], Tree) and stmt.children[1].data == "width":
                width = int(stmt.children[1].children[0])
                offset = 2
            if width == 0:
                raise DiagramError("E201", f"net {name} width must be positive", stmt.meta.line)
        sources = source_expr(stmt.children[offset])
        sinks = [signal_ref(t) for t in stmt.children[offset+1:]]
        diagram.wirings.append(Wiring(sources, sinks, name, width, stmt.meta.line))
    _resolve_wirings(diagram)
    return diagram


def parse_file(path: str | Path) -> Diagram:
    return parse(Path(path).read_text(encoding="utf-8"))
