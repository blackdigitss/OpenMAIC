"""
Local narration voice for OpenMAIC lessons: an OpenAI-style /v1/audio/speech endpoint
backed by Kokoro (open voice model, runs on this Mac's CPU, no per-use cost).
OpenMAIC's "Lemonade TTS" provider is pointed here (TTS_LEMONADE_BASE_URL).

Loopback only. One synthesis at a time (the model is CPU-bound); requests queue.
"""
import io
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HOME = os.environ.get("SENSEI_KOKORO_DIR", os.path.expanduser("~/Documents/Claude MacOs/Sensei/Library/tools/kokoro"))
PORT = int(os.environ.get("SENSEI_VOICE_PORT", "13305"))
kokoro = Kokoro(os.path.join(HOME, "kokoro-v1.0.onnx"), os.path.join(HOME, "voices-v1.0.bin"))
voices = set(kokoro.get_voices())
lock = threading.Lock()


def synthesize(text: str, voice: str, speed: float) -> tuple[bytes, int]:
    voice = voice if voice in voices else "af_heart"
    lang = "en-gb" if voice.startswith("b") else "en-us"
    with lock:
        samples, rate = kokoro.create(text, voice=voice, speed=max(0.5, min(2.0, speed)), lang=lang)
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV")
    return buf.getvalue(), rate


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status: int, body: bytes, ctype: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self.send(200, json.dumps({"object": "list", "data": [{"id": "kokoro-v1", "object": "model"}]}).encode())
        self.send(404, b'{"error":{"message":"Not found"}}')

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/audio/speech"):
            return self.send(404, b'{"error":{"message":"Not found"}}')
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            text = str(body.get("input", "")).strip()
            if not text:
                return self.send(400, b'{"error":{"message":"input is required"}}')
            wav, _ = synthesize(text, str(body.get("voice", "af_heart")), float(body.get("speed", 1.0) or 1.0))
            fmt = str(body.get("response_format", "wav")).lower()
            if fmt == "mp3":
                mp3 = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-b:a", "96k", "-f", "mp3", "pipe:1"],
                    input=wav, capture_output=True, check=True,
                ).stdout
                return self.send(200, mp3, "audio/mpeg")
            self.send(200, wav, "audio/wav")
        except Exception as e:  # report, don't crash the service
            self.send(500, json.dumps({"error": {"message": str(e)[:300]}}).encode())


if __name__ == "__main__":
    print(f"Sensei voice (Kokoro) on 127.0.0.1:{PORT}, {len(voices)} voices", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
