FROM maven:3.9.16-eclipse-temurin-25 AS java
FROM gradle:9.8.0-jdk25 AS gradle
FROM golang:1.27.1-bookworm AS go
FROM python:3.14.7-slim-bookworm AS python
FROM ghcr.io/astral-sh/uv:0.12.19 AS uv

FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep curl unzip zip build-essential pkg-config \
      libbz2-1.0 libdb5.3 libffi8 libgdbm6 libgdbm-compat4 liblzma5 \
      libncursesw6 libreadline8 libsqlite3-0 libssl3 libuuid1 libzstd1 zlib1g netbase tzdata \
    && usermod --home /workspace/home node \
    && rm -rf /var/lib/apt/lists/*

COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=java /usr/share/maven /usr/share/maven
COPY --from=gradle /opt/gradle /opt/gradle
COPY --from=go /usr/local/go /usr/local/go
COPY --from=python /usr/local /usr/local
COPY --from=uv /uv /uvx /usr/local/bin/
RUN ldconfig
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:/usr/share/maven/bin:/opt/gradle/bin:/usr/local/go/bin:/opt/python-tools/bin:$PATH

# Keep image-provided development tools separate from project virtual environments.
RUN python3 -m venv /opt/python-tools \
    && uv pip install --python /opt/python-tools/bin/python \
      pip==26.2.1 poetry==2.5.1 pytest==9.1.1 ruff==0.16.9 build==1.6.1 setuptools==84.0.0 wheel==0.48.0

# Seed a writable copy of this cache for each Sandbox user before their first task.
RUN npm install -g --allow-scripts=esbuild npm@12.1.0 corepack@0.36.0 typescript@7.0.2 tsx@4.23.15 \
    && corepack enable pnpm \
    && COREPACK_HOME=/opt/corepack corepack install --global pnpm@11.24.0 \
    && COREPACK_HOME=/opt/corepack corepack install --global pnpm@12.6.0 \
    && COREPACK_HOME=/opt/corepack corepack pnpm --version

ARG INSTALL_AGENTS=true
# Materialize native launchers during the build; Sandbox startup cannot install them.
RUN if [ "$INSTALL_AGENTS" = true ]; then \
      npm install -g --allow-scripts=@anthropic-ai/claude-code,opencode-ai \
        @openai/codex@0.157.1 @anthropic-ai/claude-code@2.1.283 opencode-ai@1.18.32; \
    fi
COPY control.mjs /opt/workspace/control.mjs
COPY git.mjs /opt/workspace/git.mjs
ENV HOME=/workspace/home
WORKDIR /workspace/repo
CMD ["node", "/opt/workspace/control.mjs", "serve"]
