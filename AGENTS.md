# Instructions for AI assistants editing Circuit Diagram DSL diagrams

The objective is a *readable microarchitecture block diagram*, not synthesizable HDL.

## Make changes safely

1. Inspect `README.md`, `examples/` and `cdiag/grammar.lark`. Do not invent syntax that the grammar does not accept.
2. Use `box "Name"` for arbitrary microarchitecture components. Give each block a unique identifier and declare its ports explicitly. Use builtins (ADD/SUB/SHIFT/SHL/SHR/SAR/MUX/DFF/ALU/CMP/SRAM) only when their pin names apply.
3. Use `A[32]` for width 32, not `A[31:0]`. Unspecified width is legal, but prefer explicit widths where known.
4. Use `bus[msb:lsb]` for slicing (inclusive, zero-based), `bus[bit]` for one bit, and `{high, low}` for concatenation. The leftmost concatenation element contributes the most-significant bits. Example: `{hi[7:0], lo[7:0]} -> dst[15:0]`. Slice only explicitly sized ports. For shift symbols use `SHL(width=32)` / `SHR(width=32)` / `SAR(width=32)` with input `A` and shift amount `B` (default 5 bits at width 32).
5. `source -> sink1, sink2` merges sinks into one net. Avoid multiple drivers. Don't represent logic functionality beyond components and wires.
6. Keep the default layout unconstrained. Add `@north` or `@south` only to improve readability (e.g. a clock/select input). Select `layout feedback` if there are cycles.
7. Prefer small meaningful displayed names. Use `label "Text"` for a customized builtin label. Use `net` to label important buses only; excessive label use harms readability.
8. Always run `python -m cdiag check examples/your_diagram.cdl` before export.
9. Use `python -m cdiag bundle examples/your_diagram.cdl -o build/your_diagram`, then on a machine with Netlist2SVG:
   `netlist2svg build/your_diagram.json --skin build/your_diagram.skin.svg -o build/your_diagram.raw.svg`
10. To print declared named nets: `python -m cdiag label-svg examples/your_diagram.cdl build/your_diagram.raw.svg -o build/your_diagram.svg`.
11. Inspect the final diagram visually. Long feedback traces may require restructuring diagram topology or switching layout preset. Don't assume the preset guarantees nice output. `--backend graphviz` only produces a fallback preview.
12. Test with `python -m pytest -q`.

## Important

- Netlist2SVG's `--skin` must match the JSON produced by `bundle`; do not mix different files.
- Compact rounded ADD/SUB/SHIFT/CMP shapes and automatic bit split/join only appear in the Netlist2SVG output, not in the Graphviz preview.
- Do not manually modify the generated Skin if the change can be specified in DSL or Python source.
- Do not claim that custom Skin output was confirmed by Netlist2SVG without actually running the binary and inspecting the final SVG.

- Use `box "Issue Scheduler" { ... }` when a scheduler is needed; it is not a built-in primitive.
- MUX is a tapered trapezoid (select defaults south); ALU is a left-notched polygon (OP defaults north); SRAM has no inner grid lines.
