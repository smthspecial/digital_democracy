# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
# packages/go/eventbus (ADR-023) is a local module referenced by go.mod's
# replace directive, at the same relative path this repo checkout has it.
COPY packages/go/eventbus packages/go/eventbus
COPY services/go/audit-service services/go/audit-service
WORKDIR /src/services/go/audit-service
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/audit-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/audit-service /audit-service
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/audit-service"]
