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

# --- Go workspace (apps/api-go, packages/go/*), per ADR-020/ADR-027 ---
GO_MODULES := apps/api-go packages/go/eventbus

go-build:
	@for m in $(GO_MODULES); do \
		echo "==> go build $$m"; \
		(cd $$m && go build ./...) || exit 1; \
	done

go-test:
	@for m in $(GO_MODULES); do \
		echo "==> go test $$m"; \
		(cd $$m && go test ./...) || exit 1; \
	done

go-vet:
	@for m in $(GO_MODULES); do \
		echo "==> go vet $$m"; \
		(cd $$m && go vet ./...) || exit 1; \
	done

# --- Containers ---
# Usage: make docker-build SERVICE=api-go (or api-ts)
# Context is the repo root -- Dockerfiles COPY shared packages/ from there.
docker-build:
	docker build -t digital-democracy/$(SERVICE):dev -f apps/$(SERVICE)/Dockerfile .
