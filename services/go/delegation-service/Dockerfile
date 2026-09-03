# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
# packages/go/eventbus (ADR-023) is a local module referenced by go.mod's
# replace directive, at the same relative path this repo checkout has it.
COPY packages/go/eventbus packages/go/eventbus
COPY services/go/delegation-service services/go/delegation-service
WORKDIR /src/services/go/delegation-service
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/delegation-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/delegation-service /delegation-service
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/delegation-service"]
