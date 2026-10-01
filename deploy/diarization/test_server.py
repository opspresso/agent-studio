"""Boundary checks without model weights, credentials, or external network."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

from server import analyze, handler


class Socket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, timeout):
        pass


class ServiceTests(unittest.TestCase):
    def request(self, headers=None, body=b"audio", infer=None, path="/diarize"):
        self.inferred = []

        def inference(path):
            self.inferred.append(path.read_bytes())
            if infer:
                return infer(path)
            return {"duration": 1, "revision": "v1", "turns": [], "warnings": []}

        values = {"Authorization": "Bearer fixture", "Content-Type": "audio/mpeg", "Content-Length": str(len(body))}
        values.update(headers or {})
        lines = [f"POST {path} HTTP/1.1"] + [f"{key}: {value}" for key, value in values.items()]
        socket = Socket(("\r\n".join(lines) + "\r\n\r\n").encode() + body)
        handler("fixture", inference)(socket, ("127.0.0.1", 1), None)
        status, payload = bytes(socket.output).split(b"\r\n\r\n", 1)
        return int(status.split()[1]), json.loads(payload)

    def test_authentication_precedes_audio_read_and_inference(self):
        status, _ = self.request({"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(self.inferred, [])

    def test_upload_and_temp_cleanup(self):
        paths = []

        def infer(path):
            paths.append(path)
            return {"duration": 1, "turns": [], "revision": "v1", "warnings": []}

        status, result = self.request(infer=infer)
        self.assertEqual(status, 200)
        self.assertEqual(result["revision"], "v1")
        self.assertEqual(self.inferred, [b"audio"])
        self.assertFalse(paths[0].exists())

    def test_supported_media_types_accept_casing_and_parameters(self):
        status, _ = self.request({"Content-Type": "Audio/MPEG; charset=utf-8"})
        self.assertEqual(status, 200)
        self.assertEqual(self.inferred, [b"audio"])

    def test_limits_and_protocol_before_inference(self):
        for headers, expected in [({"Content-Length": "536870913"}, 413),
                                  ({"Content-Length": "invalid"}, 400),
                                  ({"Transfer-Encoding": "chunked"}, 400),
                                  ({"Content-Type": "text/plain"}, 415)]:
            with self.subTest(headers=headers):
                status, _ = self.request(headers)
                self.assertEqual(status, expected)
                self.assertEqual(self.inferred, [])

    def test_inference_failure_is_not_success_and_is_redacted(self):
        def infer(path):
            raise RuntimeError("private source text")
        status, result = self.request(infer=infer)
        self.assertEqual(status, 500)
        self.assertEqual(result, {"error": "diarization_failed"})


class DecoderTests(unittest.TestCase):
    def test_real_decode_and_whole_recording_inference_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.mp3"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                            "sine=frequency=440:duration=2", "-ar", "16000", str(path)], check=True)
            seen = []
            turn = lambda start, end: SimpleNamespace(start=start, end=end)

            def pipeline(audio):
                seen.append(audio)
                return SimpleNamespace(
                    exclusive_speaker_diarization=[(turn(0, 1), "SPEAKER_00"), (turn(1, 2), "SPEAKER_01")],
                    speaker_diarization=[(turn(0, 1.1), "SPEAKER_00"), (turn(1, 2), "SPEAKER_01")])

            result = analyze(path, pipeline, "v1")
            self.assertEqual(len(seen), 1)
            self.assertEqual(tuple(seen[0]["waveform"].shape), (1, 32000))
            self.assertEqual(seen[0]["sample_rate"], 16000)
            self.assertEqual(result["duration"], 2)
            self.assertEqual(result["turns"][1]["speaker"], "SPEAKER_01")
            self.assertEqual(len(result["warnings"]), 1)


if __name__ == "__main__":
    unittest.main()
