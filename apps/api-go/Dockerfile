# Build: podman build -t digital-democracy/api-go:dev -f apps/api-go/Dockerfile .
# (or: make docker-build SERVICE=api-go LANG=go — not applicable; see root Makefile)
# Context is the repo root: the Go workspace (go.work) needs both the app
# and the shared eventbus package present at build time.
FROM docker.io/library/golang:1.22-alpine AS build
WORKDIR /src
COPY go.work go.work.sum ./
COPY packages/go/eventbus/go.mod packages/go/eventbus/go.sum packages/go/eventbus/
COPY apps/api-go/go.mod apps/api-go/go.sum apps/api-go/
RUN cd apps/api-go && go mod download 2>/dev/null || true
COPY packages/go/eventbus/ packages/go/eventbus/
COPY apps/api-go/ apps/api-go/
RUN cd apps/api-go && CGO_ENABLED=0 go build -o /out/api-go .

FROM docker.io/library/alpine:3.20
RUN adduser -D -H appuser
USER appuser
COPY --from=build /out/api-go /app/api-go
EXPOSE 5000
ENV PORT=5000
ENTRYPOINT ["/app/api-go"]
