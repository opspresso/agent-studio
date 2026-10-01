"""Actual spawn/deadline/recovery smoke check with no weights or network."""
import multiprocessing
import os
from pathlib import Path
import signal
import tempfile

from server import DiarizationTimeout, InferenceWorker, limits


def fixture_process(connection, mode):
    os.setsid()
    connection.send({"status": "ready"})
    try:
        while True:
            connection.recv()
            if mode == "stalled":
                signal.pause()
            connection.send({"status": "ok", "timeline": {"duration": 1}})
    except EOFError:
        pass
    finally:
        connection.close()


class Context:
    def __init__(self):
        self.context = multiprocessing.get_context("spawn")
        self.modes = iter(["stalled", "ready"])

    def Pipe(self):
        return self.context.Pipe()

    def Process(self, target, args):
        return self.context.Process(target=fixture_process, args=(args[0], next(self.modes)))


def main():
    limits["maxDiarizationInferenceSeconds"] = 0.2
    worker = InferenceWorker(Path("/unused-model"), "fixture", context=Context())
    try:
        worker.start()
        stalled_pid = worker.process.pid
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.write_bytes(b"fixture")
            try:
                worker.analyze(source)
            except DiarizationTimeout:
                pass
            else:
                raise AssertionError("stalled inference must time out")
            assert worker.process is None
            try:
                os.kill(stalled_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("timed-out worker was not reaped")
            assert worker.analyze(source) == {"duration": 1}
        print("PASS actual diarization process timeout, termination and next-request recovery")
    finally:
        worker.close()


if __name__ == "__main__":
    main()
