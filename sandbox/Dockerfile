FROM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d

ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.3.4 \
    && pnpm --version

# ワークフローのレビューに使うリンターも、公式配布物のハッシュを検証して同梱する。
RUN case "$TARGETARCH" in \
      amd64) checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;; \
      arm64) checksum=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 --output /tmp/actionlint.tar.gz \
      "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_${TARGETARCH}.tar.gz" \
    && echo "$checksum  /tmp/actionlint.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint \
    && rm /tmp/actionlint.tar.gz
