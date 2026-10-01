FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
# CPU is the portable default; model weights are supplied separately, never downloaded at boot.
RUN pip install --no-cache-dir torch==2.11.0 torchaudio==2.11.0 torchcodec==0.13.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir pyannote.audio==4.0.7
ENV HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 PYANNOTE_METRICS_ENABLED=0
WORKDIR /service
COPY server.py .
RUN useradd --uid 10001 --create-home diarization
USER diarization
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["python", "server.py"]
