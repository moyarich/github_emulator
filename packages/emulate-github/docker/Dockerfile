# syntax=docker/dockerfile:1

# ---- Shared operating-system tools and Node runtime ----
FROM catthehacker/ubuntu:act-latest AS tools

ENV CI=true \
  NPM_CONFIG_CACHE=/root/.npm

# Core shell, API, checkout, and archive tools used by local workflows.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  acl \
  bash \
  ca-certificates \
  coreutils \
  curl \
  git \
  gh \
  jq \
  openssh-client \
  python3 \
  python3-pip \
  python3-venv \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Keep Python packages in a virtual environment for Ubuntu compatibility.
RUN python3 -m venv /opt/python \
  && /opt/python/bin/python3 -m pip install --quiet 'ruamel.yaml'
ENV PATH="/opt/python/bin:${PATH}"

RUN mkdir -p "$NPM_CONFIG_CACHE"

# ---- Standalone Docker runtime dependencies ----
FROM tools AS dependencies
WORKDIR /app

# Install the standalone runtime directly; no project manifests are needed.
RUN npm install --no-audit --no-fund emulate portless yaml ajv
# Install the public gh-act release directly into gh's extension directory.
# gh extension install requires GH_TOKEN in CI, even for a public repository.
# Avoid embedding authentication credentials in the Docker build.
ARG GH_ACT_VERSION=v0.2.89
RUN set -eu; \
  architecture="$(uname -m)"; \
  case "$architecture" in \
    aarch64|arm64) architecture=arm64 ;; \
    x86_64) architecture=amd64 ;; \
    *) echo "Unsupported gh-act architecture: $architecture" >&2; exit 1 ;; \
  esac; \
  extension_dir="/root/.local/share/gh/extensions/gh-act"; \
  mkdir -p "$extension_dir"; \
  curl -fsSL "https://github.com/nektos/gh-act/releases/download/${GH_ACT_VERSION}/linux-${architecture}" \
    -o "$extension_dir/gh-act"; \
  chmod +x "$extension_dir/gh-act"; \
  gh act --version
ENV PATH="/app/node_modules/.bin:${PATH}"

# Startup generates and edits emulate.config.yaml using the runtime environment.

# ---- Disposable release scenario ----
COPY --chmod=755 scripts/ /app/scripts/
COPY dispatcher/ /app/dispatcher/
RUN ln -s /app/scripts/start-emulator.sh /usr/local/bin/start-emulator.sh \
  && ln -s /app/scripts/smoke-test-github-cli.sh /usr/local/bin/smoke-test-github-cli.sh \
  && ln -s /app/scripts/smoke-test-api.sh /usr/local/bin/smoke-test-api.sh


FROM dependencies AS smoke-test
CMD ["/usr/local/bin/smoke-test-api.sh"]

# ---- GitHub API server Emulator ----
FROM dependencies AS mock-github
EXPOSE 4001 443
CMD ["/usr/local/bin/start-emulator.sh"]
