SAMPLES := execution memory_pipeline scheduler netlist2svg_ready complex_feedback bit_manipulation concat_into_ports
.PHONY: all bundles previews gallery check test clean
all: previews bundles gallery
previews: $(addprefix build/,$(addsuffix .preview.svg,$(SAMPLES)))
bundles: $(addprefix build/,$(addsuffix .skin.svg,$(SAMPLES)))

build/%.preview.svg: examples/%.cdl $(wildcard cdiag/*.py) cdiag/grammar.lark
	mkdir -p build
	python -m cdiag render $< --backend graphviz -o $@

build/%.skin.svg: examples/%.cdl $(wildcard cdiag/*.py) cdiag/grammar.lark
	mkdir -p build
	python -m cdiag bundle $< -o build/$*

gallery:
	python scripts/make_gallery.py

check:
	@for src in examples/*.cdl; do python -m cdiag check "$$src" || exit 1; done

test:
	python -m pytest -q

clean:
	rm -f build/*.preview.svg build/*.skin.svg build/*.json
