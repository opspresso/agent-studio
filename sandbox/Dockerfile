FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
ARG INSTALL_AGENTS=true
RUN if [ "$INSTALL_AGENTS" = true ]; then \
      npm install -g @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.270 opencode-ai@1.18.30; \
    fi
COPY control.mjs /opt/workspace/control.mjs
COPY git.mjs /opt/workspace/git.mjs
ENV HOME=/workspace/home
WORKDIR /workspace/repo
CMD ["node", "/opt/workspace/control.mjs", "serve"]
