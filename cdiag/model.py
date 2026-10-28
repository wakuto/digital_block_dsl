"""Compiler's implementation-independent circuit graph IR."""
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Port:
    name: str
    direction: str                  # input | output
    width: int | None = None       # None is intentionally not the same as 1
    side: str | None = None
    line: int = 0


@dataclass
class Block:
    id: str
    type: str
    label: str
    ports: dict[str, Port] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)
    line: int = 0
    builtin: bool = False
    style: str | None = None


@dataclass
class Net:
    driver: str
    sinks: list[str] = field(default_factory=list)
    width: int | None = None
    name: str | None = None
    line: int = 0


@dataclass
class SignalRef:
    """A signal endpoint with an optional inclusive, descending bit selection."""
    endpoint: str
    msb: int | None = None
    lsb: int | None = None

    def __str__(self):
        if self.msb is None:
            return self.endpoint
        if self.msb == self.lsb:
            return f"{self.endpoint}[{self.msb}]"
        return f"{self.endpoint}[{self.msb}:{self.lsb}]"


@dataclass
class Wiring:
    """MSB-first concatenation of sources, delivered to each selected destination.

    A single source is represented by a one-element list. Unlike Net, this
    representation preserves both slices and concatenation semantics.
    """
    sources: list[SignalRef]
    sinks: list[SignalRef]
    name: str | None = None
    width: int | None = None
    line: int = 0


@dataclass
class Diagram:
    title: str
    direction: str = "LR"
    theme: str = "light"
    layout: str = "balanced"
    netlabels: bool = True
    ports: dict[str, Port] = field(default_factory=dict)
    blocks: dict[str, Block] = field(default_factory=dict)
    nets: list[Net] = field(default_factory=list)
    wirings: list[Wiring] = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


class DiagramError(Exception):
    def __init__(self, code: str, message: str, line: int = 0, column: int = 0):
        self.code, self.message, self.line, self.column = code, message, line, column
        super().__init__(f"{code} at {line}:{column}: {message}" if line else f"{code}: {message}")
