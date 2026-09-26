"""
Narration voice for OpenMAIC lessons: an OpenAI-style /v1/audio/speech endpoint that
OpenMAIC's "Lemonade TTS" provider points at (TTS_LEMONADE_BASE_URL).

Engine follows Settings -> Audio processing (Library/settings/audio-engine):
- local (default): Kokoro, an open voice model on this Mac's CPU (no per-use cost);
- cloud: OpenAI gpt-4o-mini-tts (SENSEI_OPENAI_API_KEY).
Whichever is chosen, the other is the automatic backup if it fails.

Loopback only. One local synthesis at a time (CPU-bound); requests queue.
"""
import io
import json
import os
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HOME = os.environ.get("SENSEI_KOKORO_DIR", os.path.expanduser("~/Documents/Claude MacOs/Sensei/Library/tools/kokoro"))
PORT = int(os.environ.get("SENSEI_VOICE_PORT", "13305"))
kokoro = Kokoro(os.path.join(HOME, "kokoro-v1.0.onnx"), os.path.join(HOME, "voices-v1.0.bin"))
voices = set(kokoro.get_voices())
lock = threading.Lock()
ENGINE_FILE = os.environ.get("SENSEI_AUDIO_ENGINE_FILE", os.path.expanduser("~/Documents/Claude MacOs/Sensei/Library/settings/audio-engine"))
OPENAI_KEY = os.environ.get("SENSEI_OPENAI_API_KEY", "")


def engine() -> str:
    try:
        with open(ENGINE_FILE) as f:
            return "cloud" if f.read().strip() == "cloud" else "local"
    except OSError:
        return "local"


def openai_speech(text: str, voice: str, speed: float, fmt: str) -> bytes:
    """OpenAI's voice; Kokoro voice names map to the closest OpenAI voice."""
    if not OPENAI_KEY:
        raise RuntimeError("no OpenAI key for the cloud voice")
    oa_voice = "ash" if voice.startswith(("am_", "bm_")) else "coral"
    body = json.dumps({"model": "gpt-4o-mini-tts", "input": text, "voice": oa_voice, "speed": speed,
                       "response_format": "mp3" if fmt == "mp3" else "wav",
                       "instructions": "Warm, clear, engaging instructor explaining respiratory therapy to a student."}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


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
            voice = str(body.get("voice", "af_heart"))
            speed = float(body.get("speed", 1.0) or 1.0)
            fmt = str(body.get("response_format", "wav")).lower()
            order = ["cloud", "local"] if engine() == "cloud" else ["local", "cloud"]
            last = None
            for which in order:
                try:
                    if which == "cloud":
                        audio = openai_speech(text, voice, speed, fmt)
                        return self.send(200, audio, "audio/mpeg" if fmt == "mp3" else "audio/wav")
                    wav, _ = synthesize(text, voice, speed)
                    break
                except Exception as e:  # try the other engine
                    last = e
            else:
                raise last or RuntimeError("no voice engine available")
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
