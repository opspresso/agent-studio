"""Private, offline whole-recording pyannote inference. No audio is persisted."""
import hmac
import json
import multiprocessing
import os
import signal
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
formats = json.loads(limits_path.with_name("formats.json").read_text())
DEMUXERS = ",".join(dict.fromkeys(formats.values()))


class DiarizationTimeout(Exception):
    pass


def inference_process(connection, model, revision):
    # Killing this process group also stops a decoder spawned by an active request.
    os.setsid()
    os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", PYANNOTE_METRICS_ENABLED="0")
    try:
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained(str(model))
        if not callable(pipeline):
            raise ValueError("Model did not load")
        connection.send({"status": "ready"})
        while True:
            path = Path(connection.recv())
            try:
                result = analyze(path, pipeline, revision)
            except (ValueError, subprocess.SubprocessError):
                connection.send({"status": "invalid_audio"})
            except Exception:
                connection.send({"status": "failed"})
            else:
                connection.send({"status": "ok", "timeline": result})
    except EOFError:
        pass
    except Exception:
        connection.send({"status": "failed"})
    finally:
        connection.close()


class InferenceWorker:
    """Persistent model process with a parent-owned deadline and crash recovery."""
    def __init__(self, model, revision, context=None):
        self.model = model
        self.revision = revision
        self.context = context or multiprocessing.get_context("spawn")
        self.process = None
        self.connection = None

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.process is not None:
            if self.process.pid is not None:
                if self.process.is_alive():
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        self.process.kill()
                self.process.join(timeout=5)
                if self.process.is_alive():
                    raise RuntimeError("Diarization worker could not stop")
                self.process.close()
            self.process = None

    def start(self):
        self.close()
        self.connection, child = self.context.Pipe()
        self.process = self.context.Process(target=inference_process, args=(child, self.model, self.revision))
        try:
            self.process.start()
            child.close()
            if not self.connection.poll(limits["maxDiarizationStartupSeconds"]):
                raise DiarizationTimeout("Model startup timed out")
            if self.connection.recv().get("status") != "ready":
                raise RuntimeError("Diarization model could not load")
        except Exception:
            child.close()
            self.close()
            raise

    def analyze(self, path):
        if self.process is None or not self.process.is_alive():
            self.start()
        try:
            self.connection.send(str(path))
            if not self.connection.poll(limits["maxDiarizationInferenceSeconds"]):
                raise DiarizationTimeout("Diarization inference timed out")
            result = self.connection.recv()
        except Exception:
            self.close()
            raise
        if result.get("status") == "invalid_audio":
            raise ValueError("Invalid audio")
        if result.get("status") != "ok":
            raise RuntimeError("Diarization inference failed")
        return result["timeline"]


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
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type not in formats:
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
            except DiarizationTimeout:
                self.reply(504, {"error": "diarization_timeout"})
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
    token = os.environ["DIARIZATION_TOKEN"]
    revision = os.environ["DIARIZATION_REVISION"]
    model = Path(os.environ.get("DIARIZATION_MODEL_PATH", "/models/community-1"))
    if not token.strip() or not revision.strip() or len(revision) > 128 or not model.is_dir():
        raise ValueError("Diarization requires a token, revision, and local model directory")
    worker = InferenceWorker(model, revision)
    try:
        worker.start()
        Server(("0.0.0.0", 8000), handler(token, worker.analyze)).serve_forever()
    finally:
        worker.close()


if __name__ == "__main__":
    main()
