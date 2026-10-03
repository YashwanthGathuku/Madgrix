FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bash coreutils \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system protocol.version 2 \
    && git config --system init.defaultBranch main

COPY promote.sh /opt/madgrix/promote.sh
COPY rebase.sh /opt/madgrix/rebase.sh
COPY copy-baseline.sh /opt/madgrix/copy-baseline.sh
RUN chmod 0555 /opt/madgrix/promote.sh /opt/madgrix/rebase.sh /opt/madgrix/copy-baseline.sh

CMD ["sleep", "infinity"]
