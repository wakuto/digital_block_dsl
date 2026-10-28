# Circuit Diagram DSL

Circuit Diagram DSL (`cdiag`) turns a small text description of a microarchitecture into an SVG block diagram. It describes blocks and connections; it is not an HDL or simulator. The compiler and CLI are written in TypeScript, and Netlist2SVG performs the SVG layout and rendering.

## Example

<details>
<summary>Source: <a href="examples/simple_riscv_datapath.cdl">simple_riscv_datapath.cdl</a></summary>

```text
version 1

diagram "Simple RISC-V Datapath" {
    direction LR
    layout feedback

    pc: box "PC" {
        in NEXT[32]
        out VALUE[32]
    }
    pc_incrementer: box "PC Incrementer" {
        in PC[32]
        out NEXT[32]
    }
    instruction_memory: box "Instruction Memory" {
        in ADDR[32]
        out INSTR[32]
    }
    decode: box "Instruction Decode" {
        in INSTR[32]
        out OP[4], RS1[5], RS2[5], RD[5], IMM[32]
        out REGWRITE, MEMWRITE, MEMTOREG, ALUSRC, BRANCH
    }
    registers: box "Integer Register File" {
        in RA1[5], RA2[5], WA[5], WD[32], WE
        out RD1[32], RD2[32]
    }
    operand_b_select: MUX(width=32) {
        label "ALU Operand B"
    }
    execute: ALU(width=32, op_width=4)
    branch_compare: CMP(width=32)
    branch_control: AND(width=1)
    branch_adder: ADD(width=32)
    pc_select: MUX(width=32)
    data_memory: box "Data Memory" {
        in ADDR[32], WDATA[32], WE
        out RDATA[32]
    }
    writeback_select: MUX(width=32)

    pc.VALUE -> pc_incrementer.PC, instruction_memory.ADDR
    instruction_memory.INSTR -> decode.INSTR
    decode.RS1 -> registers.RA1
    decode.RS2 -> registers.RA2
    decode.RD -> registers.WA
    decode.REGWRITE -> registers.WE

    registers.RD1 -> execute.A, branch_compare.A
    registers.RD2 -> operand_b_select.A, branch_compare.B, data_memory.WDATA
    decode.IMM -> operand_b_select.B
    decode.ALUSRC -> operand_b_select.S
    decode.OP -> execute.OP
    operand_b_select.Y -> execute.B
    pc.VALUE -> branch_adder.A
    decode.IMM -> branch_adder.B
    pc_incrementer.NEXT -> pc_select.A
    branch_adder.Y -> pc_select.B
    decode.BRANCH -> branch_control.A
    branch_compare.Y -> branch_control.B
    branch_control.Y -> pc_select.S
    pc_select.Y -> pc.NEXT

    execute.Y -> data_memory.ADDR
    decode.MEMWRITE -> data_memory.WE
    execute.Y -> writeback_select.A
    data_memory.RDATA -> writeback_select.B
    decode.MEMTOREG -> writeback_select.S
    writeback_select.Y -> registers.WD
}
```
</details>

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

The package name in the import examples is its module name; it does not mean the package is available from the npm registry. Install it from the GitHub repository first. Since the repository is private, your GitHub account must have access and SSH authentication must be configured:

```sh
npm install git+ssh://git@github.com/wakuto/digital_block_dsl.git#main
```

Git-based installation runs the package's `prepack` script to build the ignored `dist/` files. The renderer accepts CDL source text and resolves to an SVG string. Node applications can use the bundled Netlist2SVG renderer:

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

The logic example shows the built-in gate symbols and comparator operators:

![Rendered logic primitives](examples/rendered/logic_primitives.svg)

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
| `label "Text"` | Display label override inside a typed block (not shown for `MUX`) |

### Built-in primitive reference

In the port column, names before `→` are inputs and names after it are outputs. `n` is `width`; `m` is `shamt_width`. Width defaults to 32 bits, `addr_width` to 12 bits, and `op_width` to 4 bits. Shift amount width defaults to `ceil(log2(width))`, with a minimum of one bit.

| Primitive | Ports | Parameters | Rendered appearance |
|---|---|---|---|
| `ADD` | `A[n], B[n] → Y[n]` | `width` | `+` |
| `SUB` | `A[n], B[n] → Y[n]` | `width` | `−` |
| `AND` | `A[n], B[n] → Y[n]` | `width` | MIL AND gate |
| `OR` | `A[n], B[n] → Y[n]` | `width` | MIL OR gate |
| `XOR` | `A[n], B[n] → Y[n]` | `width` | Compact `XOR` block |
| `NOT` | `A[n] → Y[n]` | `width` | MIL inverter with bubble |
| `SHIFT`, `SHL`, `SHR`, `SAR` | `A[n], B[m] → Y[n]` | `width`, `shamt_width` | Compact operator block |
| `CMP` | `A[n], B[n] → Y[1]` | `width`, `op` (`eq` default; `ne`) | `=` or `≠` |
| `MUX` | `A[n], B[n], S[1] → Y[n]` | `width` | Narrow, unlabeled tapered symbol |
| `ALU` | `A[n], B[n], OP[op_width] → Y[n]` | `width`, `op_width` | ALU shape with left notch |
| `DFF` | `D[n], CLK[1] → Q[n]` | `width` | Storage block with clock marker |
| `SRAM` | `ADDR[addr_width], WDATA[n], WE[1], CLK[1] → RDATA[n]` | `width`, `addr_width` | Storage rectangle |

Use `box` for other components. Port names remain available for CDL connections, but the renderer hides port labels on `AND`, `OR`, `NOT`, and `MUX` symbols.

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

Arithmetic and comparison operators use compact symbols; logic gates use MIL shapes. `MUX` is a narrow tapered symbol without an internal name, `ALU` has a left-side notch, `DFF` has a clock marker, and `SRAM` is a plain rectangle. Custom `box` blocks use rectangular symbols. Port anchors and layout options are encoded in the generated Skin, and Netlist2SVG with ELK routes the connections.

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
