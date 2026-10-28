"""Diagram symbols: visual ports only, not executable hardware semantics."""
from .model import Port


def builtin(kind: str, params: dict) -> dict[str, Port] | None:
    width = params.get("width", 32)
    addr = params.get("addr_width", 12)
    op_width = params.get("op_width", 4)
    if kind in {"ADD", "SUB", "AND", "OR", "XOR"}:
        descriptors = [("A", "input", width), ("B", "input", width), ("Y", "output", width)]
    elif kind in {"SHIFT", "SHL", "SHR", "SAR"}:
        # B is the shift amount; default width is ceil(log2(data width)).
        shamt = params.get("shamt_width", max(1, (width - 1).bit_length()))
        descriptors = [("A", "input", width), ("B", "input", shamt), ("Y", "output", width)]
    elif kind == "NOT":
        descriptors = [("A", "input", width), ("Y", "output", width)]
    elif kind == "MUX":
        descriptors = [("A", "input", width), ("B", "input", width), ("S", "input", 1), ("Y", "output", width)]
    elif kind == "DFF":
        descriptors = [("D", "input", width), ("CLK", "input", 1), ("Q", "output", width)]
    elif kind == "CMP":
        descriptors = [("A", "input", width), ("B", "input", width), ("Y", "output", 1)]
    elif kind == "ALU":
        descriptors = [("A", "input", width), ("B", "input", width), ("OP", "input", op_width), ("Y", "output", width)]
    elif kind == "SRAM":
        descriptors = [("ADDR", "input", addr), ("WDATA", "input", width), ("WE", "input", 1), ("CLK", "input", 1), ("RDATA", "output", width)]
    else:
        return None
    known = {"width", "addr_width", "op_width", "shamt_width"}
    extra = set(params) - known
    if extra:
        raise ValueError(f"unsupported parameters for {kind}: {', '.join(sorted(extra))}")
    used = {"width"} | ({"addr_width"} if kind == "SRAM" else set()) | ({"op_width"} if kind == "ALU" else set()) | ({"shamt_width"} if kind in {"SHIFT", "SHL", "SHR", "SAR"} else set())
    unused = set(params) - used
    if unused:
        raise ValueError(f"unused parameter for {kind}: {', '.join(sorted(unused))}")
    for p in used:
        if p in params and (not isinstance(params[p], int) or params[p] <= 0):
            raise ValueError(f"{p} must be a positive integer")
    def initial_side(name, direction):
        if kind == "MUX" and name == "S":
            return "south"
        if kind == "ALU" and name == "OP":
            return "north"
        return "west" if direction == "input" else "east"
    return {name: Port(name, direction, bits, initial_side(name, direction))
            for name, direction, bits in descriptors}
