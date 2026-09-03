# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
# packages/go/eventbus (ADR-023) is a local module referenced by go.mod's
# replace directive, at the same relative path this repo checkout has it.
COPY packages/go/eventbus packages/go/eventbus
COPY services/go/auth-service services/go/auth-service
WORKDIR /src/services/go/auth-service
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/auth-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/auth-service /auth-service
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/auth-service"]
