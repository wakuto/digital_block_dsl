"""cdiag CLI."""
import argparse
import json
import sys
from pathlib import Path
from .parser import parse_file
from .backends import yosys_json, render_graphviz, render_netlist2svg, to_dot, write_bundle
from .model import DiagramError


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cdiag", description="Text-based digital circuit block diagrams")
    sub = ap.add_subparsers(dest="command", required=True)
    for cmd in ["check", "dump-ir", "dump-netlist", "dump-dot", "render", "bundle", "label-svg"]:
        p = sub.add_parser(cmd)
        p.add_argument("source", help=".cdl input file")
        if cmd in {"dump-ir", "dump-netlist", "dump-dot", "bundle", "label-svg"}:
            p.add_argument("-o", "--output")
        if cmd == "label-svg":
            p.add_argument("svg", help="Netlist2SVG SVG made with the CDL bundle")
            p.add_argument("--no-labels", action="store_true")
        if cmd in {"render", "bundle"}:
            p.add_argument("--theme", choices=["light", "dark", "mono"])
            p.add_argument("--layout", choices=["balanced", "compact", "feedback"])
        if cmd == "render":
            p.add_argument("-o", "--output", required=True)
            p.add_argument("--backend", choices=["graphviz", "netlist2svg"], default="graphviz")
            p.add_argument("--skin", help="netlist2svg SVG skin file")
            p.add_argument("--polyline", action="store_true", help="use Graphviz polyline routing instead of ortho")
    args = ap.parse_args(argv)
    try:
        diagram = parse_file(args.source)
        if args.command in {"render", "bundle"}:
            if args.theme: diagram.theme=args.theme
            if args.layout: diagram.layout=args.layout
        if args.command == "check":
            print(f"OK: {diagram.title} ({len(diagram.blocks)} blocks, {len(diagram.nets)} nets)")
        elif args.command == "bundle":
            if not args.output: raise DiagramError("E307", "bundle requires -o BASE (without .json)")
            files=write_bundle(diagram,args.output)
            print("Wrote Netlist2SVG pair: " + " and ".join(map(str,files)))
        elif args.command == "label-svg":
            from .svg_labels import annotate
            if args.no_labels or not diagram.netlabels:
                print("No label update requested")
            else:
                path=annotate(args.svg,diagram,yosys_json(diagram,custom_skin=True),args.output or args.svg)
                print("Wrote: "+str(path))
        elif args.command == "render":
            if args.backend == "graphviz":
                result = render_graphviz(diagram, args.output, ortho=not args.polyline)
            else:
                result = render_netlist2svg(diagram, args.output, args.skin, theme=args.theme, layout=args.layout)
            print(f"Rendered: {result}")
        else:
            if args.command == "dump-dot":
                content = to_dot(diagram)
            else:
                content = json.dumps(diagram.to_dict() if args.command == "dump-ir" else yosys_json(diagram),
                                     ensure_ascii=False, indent=2) + "\n"
            if args.output:
                Path(args.output).write_text(content, encoding="utf-8")
                print(f"Wrote: {args.output}")
            else:
                print(content, end="")
    except (DiagramError, OSError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
