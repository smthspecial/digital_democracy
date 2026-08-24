# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY services/go/audit-service/go.mod ./
RUN go mod download
COPY services/go/audit-service/. .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/audit-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/audit-service /audit-service
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/audit-service"]
