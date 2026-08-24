.PHONY: install dev build lint typecheck test go-build go-test go-vet docker-build

# --- TypeScript workspace (apps/, services/ts/, packages/) ---
install:
	pnpm install

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

# --- Go workspace (services/go/*), per ADR-020 ---
GO_SERVICES := voting-service audit-service auth-service delegation-service

go-build:
	@for s in $(GO_SERVICES); do \
		echo "==> go build services/go/$$s"; \
		(cd services/go/$$s && go build ./...) || exit 1; \
	done

go-test:
	@for s in $(GO_SERVICES); do \
		echo "==> go test services/go/$$s"; \
		(cd services/go/$$s && go test ./...) || exit 1; \
	done

go-vet:
	@for s in $(GO_SERVICES); do \
		echo "==> go vet services/go/$$s"; \
		(cd services/go/$$s && go vet ./...) || exit 1; \
	done

# --- Containers ---
# Usage: make docker-build SERVICE=voting-service LANG=go
# Context is the repo root (not the service dir) -- Dockerfiles COPY
# shared packages/ (TS) or the module's go.mod (Go) from there.
docker-build:
	docker build -t digital-democracy/$(SERVICE):dev -f services/$(LANG)/$(SERVICE)/Dockerfile .
