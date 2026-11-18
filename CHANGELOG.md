# Changelog

## v0.5
- Made the `version 1` declaration optional in CDL files.
- Added an opt-in microarchitecture diagram mode with structured tables, field-bound read/write ports, indices and address records.
- Added structural MATCH and PRIORITY primitives, mode overrides in the API/CLI, and four cache, TAGE, reservation-station and MMU examples.
- Both modes use the same built-in blocks and symbols, including MATCH, PRIORITY and vertical MUX layout.
- External input and output symbols turn with the diagram flow and can be placed on any of the four edges.
- Restored the fixed-slope MUX shape, its 2–16 data inputs, and direction arrows on block ports.
- Unannotated logic and arithmetic symbols turn with the diagram flow.
- Structured tables no longer require an entry count; index and all-entry read widths can come from wiring.
- Reorder eligible inputs in rendered diagrams to reduce wire crossings without changing port names or netlists.
- Turn split and join symbols with the diagram flow, and link table reads and writes to independent decoders with `via`.
- Render editable draw.io diagrams alongside the SVG preview when the output name ends in `.drawio.svg`.
- Preserved circuit mode defaults and the legacy box `table(...)` feature.
- A connection may start with a concatenation: `{x.Y, b} -> r.D` (previously `E001 expected declaration`). A `{` after a block declaration opens its body only when it is followed by `}` or a body declaration.
- `rank N: block, ...` (or `rank N` in a block body) maps to ELK layout partitioning, so pipeline stages keep their order with backward wires.
- `group "Label": block, ...` draws a dashed frame around blocks in the rendered SVG.
- Port names on the north and south sides of boxes and DFFs are placed inside the block and widen it so they do not overlap.
- New `REGFILE` built-in with `read_ports` and `write_ports` for multi-ported arrays.
- `npm test` runs regression tests with the Node.js test runner.

## v0.4
- MUX: tapered trapezoid (narrower output face, about 23% of input height); default `S@south`.
- ALU: classic notched, tapered polygon; default `OP@north`.
- Compact rounded rectangles for ADD, SUB, SHIFT, SHL, SHR, SAR, CMP, AND, OR, XOR, NOT.
- SRAM: removed decorative separator and repeated lines.
- Removed Issue Scheduler from the symbol-gallery primitives. It remains available as a generic user-defined `box`.
- Added geometric regression tests and refreshed all JSON+Skin bundles.
- No change to bit-concat/split DSL semantics introduced in v0.3.
- Netlist2SVG end-to-end tests require the external executable and remain optional.
