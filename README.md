# Circuit Diagram DSL (`cdiag`) v0.4

> **TypeScript implementation:** the `src/` directory contains the parser, semantic checker, IR, Yosys JSON backend, Netlist2SVG skin generator and CLI. The core parser and serializers have no runtime dependencies and can be bundled into a browser application. Python implementation files have been removed.

Build the TypeScript package with Docker (no host Node.js/npm installation required):

```powershell
docker compose run --rm typescript
```

The generated JavaScript and type declarations are written to `dist/`. For a local Node.js setup instead, run `npm install` followed by `npm run build`.

Use the Node.js API to pass source text and receive a finished SVG string:

```ts
import { renderSvg } from "@wakuto/digital-block-dsl/node";

const svg = await renderSvg(sourceText, { theme: "light", layout: "balanced" });
```

For browser apps, connect the same source-to-SVG function to Netlist2SVG's web renderer:

```ts
import { createRenderer, type Netlist2SvgEngine } from "@wakuto/digital-block-dsl";

declare global { interface Window { netlist2svg: Netlist2SvgEngine } }
const renderSvg = createRenderer(window.netlist2svg);
const svgText = await renderSvg(sourceText);
previewImage.src = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
```

Load Netlist2SVG's browser bundle and ELK bundle before this code; its [web bundle documentation](https://github.com/ajsb85/netlist2svg#web-bundle) describes those assets. The `createRenderer` adapter keeps the DSL-to-SVG API consistent across apps.

The TypeScript CLI supports source validation, JSON output, bundles and direct SVG rendering with Netlist2SVG:

```sh
npm run cdiag -- check examples/execution.cdl
npm run cdiag -- dump-ir examples/execution.cdl -o build/execution.ir.json
npm run cdiag -- dump-netlist examples/execution.cdl -o build/execution.json
npm run cdiag -- bundle examples/execution.cdl -o build/execution
npm run cdiag -- render examples/execution.cdl -o build/execution.svg
```

A **text-driven, AI-friendly block-diagram language** for microarchitecture documentation. It is a diagram generator, **not a hardware description or simulation language**.

The central feature is a paired **Yosys-compatible JSON netlist + automatically generated Netlist2SVG Skin**. Each block gets its own SVG template. That allows arbitrary block names and port counts, compact rounded ADD/SUB/SHIFT/CMP symbols, DFF/MUX/ALU/SRAM symbols, and `@north/@south/@west/@east` pin positions without modifying Netlist2SVG.

The TypeScript package and Netlist2SVG build into the included Docker Compose environment.

## First use

```bash
# Create a matched JSON + Skin pair:
npm run cdiag -- bundle examples/execution.cdl -o build/execution
# --> build/execution.json + build/execution.skin.svg

# Generate a final SVG directly from CDL with Netlist2SVG:
docker compose run --rm typescript npm run cdiag -- render examples/execution.cdl -o build/execution.svg

# Compile the TypeScript package in Docker:
docker compose run --rm typescript
```

## Example block diagrams

- [`simple_riscv_datapath.cdl`](examples/simple_riscv_datapath.cdl): instruction decode, register file, ALU, branch selection, memory and writeback.
- [`streaming_fir.cdl`](examples/streaming_fir.cdl): a three-tap FIR pipeline with sample delays, multipliers, an adder tree and valid tracking.
- [`dma_engine.cdl`](examples/dma_engine.cdl): transfer control, source/destination pointers, byte counter and memory request interface with a feedback-oriented layout.

Validate all three with `npm run cdiag -- check examples/<name>.cdl`, render directly from their CDL files, or create a JSON + Skin pair with the `bundle` command above.

**Important:** Do not mix JSON and Skin files from different bundles. Bundle output uses distinct `CDL__<instance>` cell types which match its per-instance Skin. The `dump-netlist` command emits the stock-Skin format.

## Syntax

```text
version 1

diagram "Execution Datapath" {
    direction LR
    theme light
    layout feedback
    netlabels on

    input a[32], b[32], enable, clk
    output y[32]

    add: ADD(width=32)
    mux: MUX(width=32) {
        in S@south
    }
    reg: DFF(width=32) {
        label "Result Register"
        in CLK@north
        style storage
    }
    memory: box "Data SRAM" {
        style storage
        in ADDR[32], WE
        in CLK@north
        out RDATA[32]
    }

    a -> add.A
    b -> add.B
    add.Y -> mux.A, memory.ADDR
    memory.RDATA -> mux.B
    enable -> mux.S
    mux.Y -> reg.D
    clk -> reg.CLK, memory.CLK
    net result_bus[32] = reg.Q -> y
}
```

The above is syntactically and structurally valid. **Use `examples/*.cdl` for additional runnable diagrams.**

### Bit slicing and concatenation (v0.3)

Bit selections use **zero-based, inclusive, LSB-indexed bit numbers**. An
unselected endpoint is an entire bus. The width declaration `a[32]` declares
**32 bits**, whereas the *expression* `a[7]` selects **bit 7**:

```text
version 1

diagram "Bit Wiring" {
    input hi[8], lo[8], data[32]
    output joined[16], high[16], low[8], bit_7[1]

    {hi, lo} -> joined
    data[31:16] -> high
    data[7:0] -> low
    data[7] -> bit_7
}
```

Concatenation is **most-significant-part first**, exactly like Verilog's
`{hi, lo}`. The generated Yosys JSON has the `lo` bits at its lower indices.
Slicing is allowed on output ports of blocks and inputs of diagram, as well as
on input ports of blocks and outputs of diagram when used as sinks:

```text
    a -> decoder.INSTR[15:8]
    b -> decoder.INSTR[7:0]
    {decoder.OPCODE, decoder.IMM} -> register.D
    register.Q[15:8] -> high
```

No additional hardware operation is modeled: the compiler maps the individual
bit IDs. Netlist2SVG's split/join detection can depict the necessary wiring
junctions. Concatenations with multiple parts are supported; an individual
part may itself be a slice. Nesting braces inside braces, bit constants,
permutations other than explicit concatenation, and arbitrary bit expressions
are not currently supported.

Widths are checked exactly, without implicit truncation, zero/sign extension
or padding. A sliced endpoint must have a width *explicitly declared* on its
port (width inference alone is not enough). All destination bits are checked
for multiple distinct drivers, including overlapping partial assignments.
Omitted widths on whole-port connections may be inferred; in concatenations,
there must be at most one unknown component with a known total width.

The canonical IR stores all connections in `wirings`. The original `nets`
collection is retained for whole-port legacy connections only; use `wirings`
for any programmatic inspection that must include slices or concatenations.

### Diagram symbols (v0.4)

The default generated skin uses:

| Kind | Shape | Notes |
|---|---|---|
| `ADD`, `SUB`, `CMP`, `SHIFT`, `SHL`, `SHR`, `SAR` | Compact rounded rectangles | Only the operator name appears; narrow block sizes, ports on rectangle edges |
| `AND`, `OR`, `XOR`, `NOT` | Compact rounded rectangles | Same sizing as arithmetic operators |
| `MUX` | Trapezoid with broad input edge and **23% height** output edge | A/B enter left; selector S defaults to the lower sloping side; Y exits right |
| `ALU` | Classic concave V-notch on the left, sloping top/bottom | A/B enter on the left, OP defaults to the top sloping edge; Y exits right |
| `DFF` | Register box with clock edge triangle | Default D/CLK input and Q output |
| `SRAM` | Plain labeled rectangle | No internal horizontal lines or memory-cell decoration |
| `box "Name"` | Generic labeled rectangle | Use this for arbitrary user-defined units; **Issue Scheduler is not a builtin** |

The shape conventions follow textbook microarchitecture diagrams, rather than
strict schematic symbols for physical integrated circuits. Most settings affect
only the rendered SVG Skin. `MUX.S` and `ALU.OP` have new default port sides,
but the DSL still allows explicit `in S@west` or `in OP@west` overrides.

All the width parameters and bit slicing/concatenation introduced in v0.3
remain unchanged. The shift amount width defaults to `ceil(log2(width))`,
minimum one bit, overridable via `shamt_width=N`.

For final Netlist2SVG rendering, always use the matching JSON + Skin pair produced by `npm run cdiag -- bundle`.

### Supported declarations

| Syntax | Meaning |
|---|---|
| `direction LR\|RL\|TB\|BT` | Drawing direction, default LR |
| `theme light\|dark\|mono` | Global SVG palette |
| `layout compact\|balanced\|feedback` | ELK spacing / cycle breaking preset; default balanced |
| `netlabels on\|off` | Retain the flag in IR; automatic post-render labels are not currently generated |
| `name: TYPE(width=N)` | Built-in component: `ADD`, `SUB`, `MUX`, `DFF`, `CMP`, `ALU`, `SRAM`, gates |
| `id: box "Label" { in A; out Y }` | Arbitrary named box |
| `in CLK@north` | Named input port on a requested side |
| `style logic\|storage\|control\|neutral\|accent` | Per-block color role |
| `label "..."` | Display name override on typed block |
| `p.Q -> q.D, r.A` | Single driver, multiple sinks |
| `p.Q[15:8] -> q.D[7:0]` | Slice with an inclusive bit range |
| `p.Q[7] -> out` | Select a single bit; output must be one bit |
| `{hi, lo} -> combined` | Concatenate signals, most-significant first |
| `net output_bus[32] = p.Q -> q.D` | Named net; `[32]` is 32 bits |

Widths omitted mean *unspecified*, not 1 bit. The compiler infers widths across one net and rejects incompatible explicit widths. There is no silent truncation or padding, no RTL expressions, and no electrical semantics. Empty unconnected ports are permitted.

### Routing caveats

The program asks **ELK** for orthogonal routing and provides preset spacing/cycle breaking options. The `feedback` preset allocates somewhat more space to feedback loops, but **cannot promise zero long detours** in every graph. Diagram layout remains a heuristic optimization. Per-pin sides are encoded in Skin template anchor geometry, while inter-block placement remains automatic.

The Netlist2SVG skin format supports `s:pid`, `s:x`, `s:y`, `s:width` and `s:height`, and ELK global options in `s:properties`. This tool generates templates with these fields. `<s:generic>` placeholders and Netlist2SVG special node templates are included. The upstream renderer might require compatibility adjustments for particular releases.

### Names on wires

Named nets are included in the generated Yosys JSON. Automatic post-render SVG label placement is not currently part of the TypeScript implementation.

### AsciiDoc

```asciidoc
.Execution Datapath
image::build/execution.svg[width=800]
```

Generate the SVG with Netlist2SVG from the matching JSON + Skin pair before rendering the AsciiDoc document.

## AI workflow

Read [AGENTS.md](AGENTS.md). For each changed diagram: write/edit `.cdl` → `npm run cdiag -- check` → `npm run cdiag -- render` → inspect the SVG and revise as necessary. Use `bundle` when you need the intermediate JSON + Skin pair.

## CLI summary

```
npm run cdiag -- check FILE.cdl
npm run cdiag -- dump-ir FILE.cdl [-o file.json]
npm run cdiag -- dump-netlist FILE.cdl [-o file.json]  # stock skin format
npm run cdiag -- bundle FILE.cdl -o BASENAME
npm run cdiag -- render FILE.cdl -o out.svg [--theme light|dark|mono] [--layout compact|balanced|feedback]
```

## Scope / limitations

Module reuse / hierarchical groups, constants, HDL functions, bidirectional interface bundles, manual routes, complex layout order constraints, IDE support, and interactive zoom remain out of scope. Generated Skin SVG itself is a **template file**, not the final layout; pair it with the JSON and render via Netlist2SVG.

## Source

- `src/parser.ts`: tokenizer, parser, semantic checker, width inference and IR construction
- `src/symbols.ts`: built-in block port definitions and parameter validation
- `src/netlist.ts`: Yosys-compatible JSON output
- `src/skin.ts`: per-instance SVG symbols and ELK layout settings
- `src/cli.ts`: Node.js command-line entry point
- `Dockerfile` / `compose.yaml`: reproducible TypeScript build environment

See [Netlist2SVG](https://github.com/ajsb85/netlist2svg) and [ELK](https://eclipse.dev/elk/) for the renderer/route algorithm.
