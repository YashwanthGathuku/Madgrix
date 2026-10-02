FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bash coreutils \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system protocol.version 2 \
    && git config --system init.defaultBranch main

CMD ["sleep", "infinity"]
