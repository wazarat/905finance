# The 905 Finance testing worker.
#
# Build from the repository root, so that the bundled fixtures are included:
#   docker build -f worker/Dockerfile -t 905finance-worker .
#
# The image holds the worker, the fixtures and the testing tools. It is given
# two settings at run time, APP_URL and WORKER_TOKEN, and nothing else: no
# database address, no session secret, no wallet or signing credential.
FROM node:24-bookworm-slim

ARG FOUNDRY_VERSION=v1.7.1
ARG SLITHER_VERSION=0.11.6

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Everything from here on, including every test, runs as an unprivileged user.
USER node
ENV HOME=/home/node
ENV PATH=/home/node/.foundry/bin:/home/node/venv/bin:$PATH

RUN curl -fsSL https://foundry.paradigm.xyz | bash \
  && foundryup --install "${FOUNDRY_VERSION}"

# Running Slither once creates the directories it expects under the home
# directory, so that it also starts on a read-only filesystem.
RUN python3 -m venv /home/node/venv \
  && pip install --no-cache-dir "slither-analyzer==${SLITHER_VERSION}" \
  && slither --version

WORKDIR /app
COPY --chown=node:node worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node worker/src ./worker/src
COPY --chown=node:node fixtures ./fixtures

# Fetch the Solidity compiler the fixture needs now, so that running a job
# never has to download anything.
RUN cd fixtures/sample-solidity-vault && forge build && rm -rf out cache \
  && mkdir -p /app/worker/.runs

ENV NODE_ENV=production \
    FIXTURES_DIR=/app/fixtures
WORKDIR /app/worker
CMD ["node", "src/main.mjs"]
