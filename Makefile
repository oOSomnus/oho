BUN ?= bun

.PHONY: build test quick-install

build:
	$(BUN) run build

test:
	$(BUN) run test

quick-install:
	$(BUN) setup
