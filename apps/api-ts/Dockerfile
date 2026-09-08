# Build: podman build -t digital-democracy/api-ts:dev -f apps/api-ts/Dockerfile .
# Context is the repo root. Zero dependencies: no package manager step.
FROM docker.io/library/node:20-alpine
RUN adduser -D -H appuser
USER appuser
WORKDIR /app
COPY apps/api-ts/package.json ./
COPY apps/api-ts/src/ ./src/
EXPOSE 4000
ENV PORT=4000 NODE_ENV=production
CMD ["node", "src/index.js"]
