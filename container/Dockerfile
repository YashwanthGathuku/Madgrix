FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bash coreutils \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system protocol.version 2 \
    && git config --system init.defaultBranch main

COPY promote.sh /opt/madgrix/promote.sh
COPY rebase.sh /opt/madgrix/rebase.sh
COPY copy-baseline.sh /opt/madgrix/copy-baseline.sh
# A Windows checkout can COPY CRLF. Strip CR before the shebang runs, then
# refuse a script that still contains CR or that Bash will not parse.
RUN sed -i 's/\r$//' /opt/madgrix/promote.sh /opt/madgrix/rebase.sh /opt/madgrix/copy-baseline.sh \
    && if grep -a -q "$(printf '\r')" /opt/madgrix/promote.sh /opt/madgrix/rebase.sh /opt/madgrix/copy-baseline.sh; then \
         echo "container scripts still contain CR" >&2; exit 1; \
       fi \
    && bash -n /opt/madgrix/promote.sh \
    && bash -n /opt/madgrix/rebase.sh \
    && bash -n /opt/madgrix/copy-baseline.sh \
    && chmod 0555 /opt/madgrix/promote.sh /opt/madgrix/rebase.sh /opt/madgrix/copy-baseline.sh

CMD ["sleep", "infinity"]
