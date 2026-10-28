# Circuit Diagram DSL

Circuit Diagram DSL (`cdiag`) turns a small text description of a microarchitecture into an SVG block diagram. It describes blocks and connections; it is not an HDL or simulator. The compiler and CLI are written in TypeScript, and Netlist2SVG performs the SVG layout and rendering.

## Example

Input: [`simple_riscv_datapath.cdl`](examples/simple_riscv_datapath.cdl)

Output:

![Rendered Simple RISC-V Datapath](examples/rendered/simple_riscv_datapath.svg)

## Quick start

Build the TypeScript package and render an example directly from its CDL source:

```sh
docker compose run --rm typescript
docker compose run --rm typescript npm run cdiag -- render examples/simple_riscv_datapath.cdl -o build/simple_riscv_datapath.svg
```

The first command compiles the package. The second writes the rendered SVG to `build/`. The Docker environment includes Netlist2SVG, so no host Node.js installation is required.

With Node.js installed locally, use `npm install` and `npm run build`, then run:

```sh
npm run cdiag -- render examples/simple_riscv_datapath.cdl -o build/simple_riscv_datapath.svg
```

## Use from an application

The renderer accepts CDL source text and resolves to an SVG string. Node applications can use the bundled Netlist2SVG renderer:

```ts
import { renderSvg } from "@wakuto/digital-block-dsl/node";

const svgText = await renderSvg(sourceText, {
  theme: "light",
  layout: "balanced",
});
```

Browser applications can connect the same source-to-SVG adapter to Netlist2SVG's web renderer:

```ts
import {
  createRenderer,
  type Netlist2SvgEngine,
} from "@wakuto/digital-block-dsl";

declare global {
  interface Window { netlist2svg: Netlist2SvgEngine }
}

const renderSvg = createRenderer(window.netlist2svg);
const svgText = await renderSvg(sourceText);
previewImage.src = URL.createObjectURL(
  new Blob([svgText], { type: "image/svg+xml" }),
);
```

Load Netlist2SVG's browser bundle and ELK bundle before calling `createRenderer`; see the [Netlist2SVG web bundle guide](https://github.com/ajsb85/netlist2svg#web-bundle). The DSL parser, semantic checks, JSON generation and Skin generation are also exported separately for applications that need those stages.

For a page that stores CDL inline, read the source from a `<script type="text/cdl">` element and pass its text to `renderSvg`. The same pattern works with fetched files, editor contents or a server response.

## CLI

```sh
npm run cdiag -- check FILE.cdl
npm run cdiag -- render FILE.cdl -o OUTPUT.svg [--theme light|dark|mono] [--layout compact|balanced|feedback]
npm run cdiag -- dump-ir FILE.cdl [-o OUTPUT.json]
npm run cdiag -- dump-netlist FILE.cdl [-o OUTPUT.json]
npm run cdiag -- bundle FILE.cdl -o BASENAME
```

`render` is the usual path: it parses the source and returns a final SVG using Netlist2SVG. `bundle` writes a matched `BASENAME.json` and `BASENAME.skin.svg` pair for manual or offline rendering. Keep the two files from a bundle together. `dump-netlist` emits the stock-Skin JSON format; `bundle` emits JSON with per-instance Skin cell types.

## Examples

- [`simple_riscv_datapath.cdl`](examples/simple_riscv_datapath.cdl) — PC and incrementer, instruction memory and decode, register-file read/write paths, ALU operand mux, branch compare, data memory and writeback.
- [`logic_primitives.cdl`](examples/logic_primitives.cdl) — arithmetic and logic operators, including equality and inequality comparators.
- [`streaming_fir.cdl`](examples/streaming_fir.cdl) — a three-tap FIR pipeline with sample delays, multipliers and an adder tree.
- [`dma_engine.cdl`](examples/dma_engine.cdl) — transfer control, source and destination pointers, byte counter and memory interface.
- The [`examples/`](examples) directory also contains scheduler, memory pipeline, feedback and bit-manipulation diagrams.

## CDL syntax

Each file contains one version 1 diagram. Declarations are separated by whitespace or newlines; `//` starts a comment.

```text
version 1

diagram "Execution Datapath" {
    direction LR
    theme light
    layout balanced

    input a[32], b[32], enable, clk
    output result[32]

    add: ADD(width=32)
    mux: MUX(width=32) { in S@south }
    reg: DFF(width=32) { in CLK@north }

    a -> add.A
    b -> add.B
    add.Y -> mux.A
    reg.Q -> mux.B
    enable -> mux.S
    mux.Y -> reg.D
    clk -> reg.CLK
    reg.Q -> result
}
```

### Diagram and block settings

| Declaration | Meaning |
|---|---|
| `direction LR`, `RL`, `TB`, `BT` | Diagram direction; defaults to `LR` |
| `theme light`, `dark`, `mono` | SVG color theme |
| `layout compact`, `balanced`, `feedback` | ELK spacing and cycle-breaking preset |
| `netlabels on`, `off` | Retained in the IR; automatic post-render labels are not implemented |
| `id: TYPE(width=32)` | Built-in block with named ports |
| `id: box "Label" { in A[32] out Y[32] }` | Custom block with explicitly declared ports |
| `in CLK@north`, `out Y@east` | Optional port side: `west`, `east`, `north`, or `south` |
| `style logic`, `storage`, `control`, `neutral`, `accent` | Block fill color role |
| `label "Text"` | Display label override inside a typed block |

Built-ins are `ADD`, `SUB`, `SHIFT`, `SHL`, `SHR`, `SAR`, `AND`, `OR`, `XOR`, `NOT`, `MUX`, `DFF`, `CMP`, `ALU`, and `SRAM`. Logic and arithmetic operators render with familiar symbols such as `+`, `∧`, `∨`, and `¬`. `CMP` displays `=` by default; set `op="ne"` for `≠`. Use `box` for other components. Parameters include `width`, `addr_width`, `op_width`, and `shamt_width` where applicable. Shift amount width defaults to `ceil(log2(width))`, with a minimum of one bit.

### Connections, slices and concatenation

```text
a -> add.A
add.Y -> mux.A, result
data[31:16] -> upper_half
data[7] -> selected_bit
{high, low} -> combined
net writeback[32] = reg.Q -> result
```

Widths such as `a[32]` declare a 32-bit port. Slice expressions such as `data[7]` select zero-based inclusive bit indices. Concatenations are most-significant part first: `{high, low}` places `low` at the least significant bits.

The compiler infers unspecified widths across whole-port connections. It rejects width mismatches, reversed or out-of-range slices, and destination bits with multiple distinct drivers. Slices require explicitly sized ports. In a concatenation, at most one source part may have an inferred width, and its width must be determined by the connection.

The complete wiring is preserved in `diagram.wirings`. The legacy `diagram.nets` list includes whole-port connections only.

## Symbols and rendering

Operators use compact rounded symbols with familiar arithmetic and logic glyphs. `MUX` is tapered, `ALU` has a left-side notch, `DFF` has a clock marker, and `SRAM` is a plain rectangle. Custom `box` blocks use rectangular symbols. Port anchors and layout options are encoded in the generated Skin, and Netlist2SVG with ELK routes the connections.

The layout presets guide the algorithm; they cannot guarantee short routes for every feedback graph. Generated Skin SVGs are templates, not final diagrams. Final output comes from the `render` command or Netlist2SVG rendering a matched bundle.

Named nets are included in the generated Yosys JSON. Automatic placement of named-net text labels on the rendered SVG is not currently implemented.

## Development

```sh
docker compose run --rm typescript
docker compose run --rm typescript npm run cdiag -- check examples/execution.cdl
```

- `src/parser.ts` — tokenizer, parser, semantic checks, width inference and IR construction
- `src/netlist.ts` — Yosys-compatible JSON
- `src/skin.ts` — Netlist2SVG Skin generation
- `src/render-core.ts` — renderer adapter for Node or browser engines
- `src/node.ts` — Node API backed by the installed Netlist2SVG package
- `src/cli.ts` — command-line interface

Module reuse, hierarchical groups, constants, HDL expressions, bidirectional bundles, manual routes and interactive editing are outside the current scope.
