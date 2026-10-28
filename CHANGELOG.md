# Changelog

## v0.4
- MUX: tapered trapezoid (narrower output face, about 23% of input height); default `S@south`.
- ALU: classic notched, tapered polygon; default `OP@north`.
- Compact rounded rectangles for ADD, SUB, SHIFT, SHL, SHR, SAR, CMP, AND, OR, XOR, NOT.
- SRAM: removed decorative separator and repeated lines.
- Removed Issue Scheduler from the symbol-gallery primitives. It remains available as a generic user-defined `box`.
- Added geometric regression tests and refreshed all JSON+Skin bundles.
- No change to bit-concat/split DSL semantics introduced in v0.3.
- Netlist2SVG end-to-end tests require the external executable and remain optional.
