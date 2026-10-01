"""Private, offline whole-recording pyannote inference. No audio is persisted."""
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The app and this service consume the same domain-owned request/timeline limits.
limits_path = os.environ.get("AUDIO_LIMITS_PATH")
if limits_path is None:
    limits_path = Path(__file__).resolve().parents[2] / "src/domain/audio/limits.json"
limits_path = Path(limits_path)
limits = json.loads(limits_path.read_text())
MAX_BYTES = limits["maxDiarizationInputBytes"]
MAX_SECONDS = limits["maxSeconds"]
SAMPLE_RATE = 16000
DEMUXERS = "mp3,wav,flac,ogg"


def analyze(path, pipeline, revision):
    decoded = path.with_name("decoded.wav")
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-y",
        "-max_alloc", "268435456", "-protocol_whitelist", "file", "-threads", "1",
        "-format_whitelist", DEMUXERS, "-i", str(path), "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-t", str(MAX_SECONDS + 1), "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "pcm_s16le", str(decoded),
    ], check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with wave.open(str(decoded), "rb") as audio:
        frames = audio.getnframes()
        duration = frames / SAMPLE_RATE
        if not 0 < duration <= MAX_SECONDS:
            raise ValueError("Invalid duration")
        pcm = audio.readframes(frames)
    # Pass decoded waveform to avoid a second decoder or network-backed loader.
    import numpy as np
    import torch
    waveform = torch.from_numpy(np.frombuffer(pcm, dtype="<i2").copy()).float().unsqueeze(0) / 32768
    with torch.inference_mode():
        output = pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE})
    turns = [{"start": max(0.0, float(turn.start)), "end": min(duration, float(turn.end)), "speaker": speaker}
             for turn, speaker in output.exclusive_speaker_diarization]
    turns = [turn for turn in turns if turn["end"] > turn["start"]]
    if len(turns) > limits["maxSpeakerTurns"]:
        raise ValueError("Too many turns")
    warnings = []
    end = 0.0
    for turn, _ in output.speaker_diarization:
        if float(turn.start) < end:
            warnings.append("Overlapping speech was detected; exclusive attribution cannot separate simultaneous voices.")
            break
        end = max(end, float(turn.end))
    if not turns:
        warnings.append("No speakers were detected; speaker attribution is unavailable.")
    return {"duration": duration, "revision": revision, "turns": turns, "warnings": warnings}


def handler(token, infer):
    # One inference/request body at a time bounds memory and avoids pipeline races.
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log credentials, request paths, or audio-derived content.

        def reply(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"ready": self.path == "/health"})

        def do_POST(self):
            if self.path != "/diarize":
                self.reply(404, {"error": "not_found"})
                return
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode()):
                self.reply(401, {"error": "unauthorized"})
                return
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                self.reply(400, {"error": "content_length_required"})
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
                if not 0 < length <= MAX_BYTES:
                    self.reply(413, {"error": "audio_size_invalid"})
                    return
            except ValueError:
                self.reply(400, {"error": "content_length_invalid"})
                return
            if self.headers.get("Content-Type") not in {"audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/flac", "audio/ogg"}:
                self.reply(415, {"error": "audio_format_unsupported"})
                return
            if not busy.acquire(blocking=False):
                self.reply(503, {"error": "diarization_busy"})
                return
            try:
                self.connection.settimeout(60)
                with tempfile.TemporaryDirectory(prefix="diarization-") as directory:
                    path = Path(directory) / "source"
                    with path.open("wb") as audio:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 1024 * 1024))
                            if not chunk:
                                raise ValueError("Incomplete audio")
                            audio.write(chunk)
                            remaining -= len(chunk)
                    self.reply(200, infer(path))
            except (ValueError, subprocess.SubprocessError):
                self.reply(422, {"error": "audio_invalid"})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
            except Exception:
                self.reply(500, {"error": "diarization_failed"})
            finally:
                busy.release()

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(60)
        return connection, address


def main():
    # Force offline operation before importing model libraries. No startup download.
    os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", PYANNOTE_METRICS_ENABLED="0")
    token = os.environ["DIARIZATION_TOKEN"]
    revision = os.environ["DIARIZATION_REVISION"]
    model = Path(os.environ.get("DIARIZATION_MODEL_PATH", "/models/community-1"))
    if not token.strip() or not revision.strip() or len(revision) > 128 or not model.is_dir():
        raise ValueError("Diarization requires a token, revision, and local model directory")
    from pyannote.audio import Pipeline
    pipeline = Pipeline.from_pretrained(str(model))
    Server(("0.0.0.0", 8000), handler(token, lambda path: analyze(path, pipeline, revision))).serve_forever()


if __name__ == "__main__":
    main()
