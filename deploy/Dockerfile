# The household meal planner, as a container.
#
# Build (from the repository's top folder):
#   docker build -f deploy/Dockerfile -t household-meal-planner .
# Most people use deploy/compose.yaml instead, which builds this and wires up the folders.
#
# What goes where:
#   /app/config.toml   your settings, mounted read-only (never baked into the image)
#   /app/data          your profile, weekly plans, recipe catalog (a volume: back it up)
#   /app/state         running state: message journal, markers, locks (a volume)
#   secrets            passed as environment variables (compose reads them from .env)
#
# This image has no Signal support. For Signal, use deploy/Dockerfile.signal.

FROM oven/bun:1

WORKDIR /app

# Dependencies first, so rebuilding after a code change reuses this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./
COPY data.example ./data.example

# The bot runs as an ordinary user, not root. The "bun" user already exists in this base image.
RUN mkdir -p /app/data /app/state && chown -R bun:bun /app/data /app/state
USER bun

ENV HMP_CONFIG=/app/config.toml
VOLUME ["/app/data", "/app/state"]

# check-health reads only the state files the bridge leaves behind. It reports "unhealthy" when the
# bridge's heartbeat is stale, a message has gone unanswered, or the weekly draft is late. The start
# period gives a fresh install time to make its first heartbeat.
HEALTHCHECK --interval=60s --timeout=30s --start-period=3m --retries=1 \
  CMD ["bun", "run", "check-health"]

CMD ["bun", "run", "start"]
