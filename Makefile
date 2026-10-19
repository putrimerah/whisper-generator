# whisper-generator
#
# One command to remember:
#
#     make
#
# Installs what is missing, rebuilds what changed, starts the web app and
# opens it in the Windows browser.

SHELL := /bin/bash
.DEFAULT_GOAL := run

# PORT: command line > WG_PORT in .env > 7788
ENV_PORT := $(shell [ -f .env ] && grep -E '^WG_PORT=' .env | tail -1 | cut -d= -f2 | tr -d ' \r')
PORT ?= $(if $(ENV_PORT),$(ENV_PORT),7788)
NODE := node
VENV := $(HOME)/.wg/venv
WHISPER := $(VENV)/bin/whisper-ctranslate2

SERVER_SRC := $(shell find src -name '*.ts' -not -name '*.test.ts' 2>/dev/null)
WEB_SRC := $(shell find web/src -type f 2>/dev/null) web/index.html web/vite.config.ts

GREEN := \033[32m
BOLD := \033[1m
DIM := \033[2m
OFF := \033[0m

.PHONY: run start dev stop build test check doctor setup install link clean reset update help transcribe env

env: .env ## Create .env from .env.example if missing

## ---------------------------------------------------------------- main

run: .env build ## Build if needed, start the web app, open the browser
	@echo -e "$(BOLD)whisper-generator$(OFF) → http://localhost:$(PORT)"
	@$(MAKE) --no-print-directory stop
	@$(NODE) dist/cli.js ui --port $(PORT) --open

start: run ## Alias for `make run`

dev: .env node_modules web/node_modules ## Live-reloading UI (Vite on 5173, API on 7788)
	@echo -e "$(DIM)API on $(PORT), UI on 5173 with hot reload$(OFF)"
	@$(MAKE) --no-print-directory stop
	@npm run build:server >/dev/null
	@( $(NODE) dist/cli.js ui --port $(PORT) & echo $$! > .dev.pid ) ; \
	 trap 'kill $$(cat .dev.pid) 2>/dev/null; rm -f .dev.pid' EXIT ; \
	 npm --prefix web run dev

stop: ## Stop a server already listening on $(PORT)
	@pid=$$(ss -lptn "sport = :$(PORT)" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1) ; \
	 if [ -n "$$pid" ]; then echo -e "$(DIM)stopping previous server (pid $$pid)$(OFF)"; kill $$pid; sleep 1; fi

## ---------------------------------------------------------------- build

build: dist/cli.js web/dist/index.html ## Compile server and web app

dist/cli.js: $(SERVER_SRC) tsconfig.json package.json | node_modules
	@echo -e "$(DIM)compiling server…$(OFF)"
	@npm run build:server >/dev/null

web/dist/index.html: $(WEB_SRC) | web/node_modules
	@echo -e "$(DIM)building web app…$(OFF)"
	@npm --prefix web run build >/dev/null

.env: .env.example
	@test -f .env || { cp .env.example .env; echo -e "$(GREEN)created .env$(OFF) from .env.example — edit it to change default folders"; }
	@touch .env

node_modules: package.json
	@echo -e "$(DIM)installing server dependencies…$(OFF)"
	@npm install --no-audit --no-fund >/dev/null
	@touch node_modules

web/node_modules: web/package.json
	@echo -e "$(DIM)installing web dependencies…$(OFF)"
	@npm --prefix web install --no-audit --no-fund >/dev/null
	@touch web/node_modules

## ---------------------------------------------------------------- checks

test: node_modules ## Run the test suite
	@npm test

check: node_modules ## Typecheck, test, build — run before committing
	@npm run typecheck && npm test && $(MAKE) --no-print-directory build
	@echo -e "$(GREEN)all checks passed$(OFF)"

doctor: dist/cli.js ## Check ffmpeg, Whisper, CUDA libraries, VRAM vs model
	@$(NODE) dist/cli.js doctor

## ---------------------------------------------------------------- setup

setup: install ## Alias for `make install`

install: node_modules web/node_modules $(WHISPER) ## Install everything, including Whisper and ffmpeg
	@$(MAKE) --no-print-directory build
	@$(MAKE) --no-print-directory doctor

$(WHISPER):
	@echo -e "$(DIM)installing ffmpeg + whisper-ctranslate2 (no sudo, ~10 min)…$(OFF)"
	@bash scripts/install-wsl.sh

link: build ## Make `wg` available anywhere
	@npm link >/dev/null && echo -e "$(GREEN)wg$(OFF) is now on your PATH"

update: ## Pull, reinstall dependencies, rebuild
	@git pull --ff-only
	@npm install --no-audit --no-fund >/dev/null
	@npm --prefix web install --no-audit --no-fund >/dev/null
	@$(MAKE) --no-print-directory build

## ---------------------------------------------------------------- misc

transcribe: dist/cli.js ## Transcribe from the terminal: make transcribe FILE=path [ARGS="--attendees Irfan"]
	@test -n "$(FILE)" || { echo "usage: make transcribe FILE=<path> [ARGS=\"--attendees 'A,B'\"]"; exit 1; }
	@$(NODE) dist/cli.js run "$(FILE)" $(ARGS)

clean: ## Remove build output
	@rm -rf dist web/dist
	@echo "build output removed"

reset: clean ## Remove build output and all dependencies
	@rm -rf node_modules web/node_modules
	@echo "dependencies removed; run make install"

help: ## Show this help
	@echo -e "$(BOLD)whisper-generator$(OFF)"
	@echo
	@echo -e "  $(BOLD)make$(OFF)                 build and open the web app"
	@echo
	@grep -hE '^[a-z/.%$$()a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sed 's/:.*##/|/' \
	  | awk -F'|' '{ printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }'
	@echo
	@echo -e "$(DIM)PORT=$(PORT) — override with: make PORT=8080$(OFF)"
