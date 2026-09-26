"""
Sensei's voice service for OpenMAIC lessons (OpenAI-style endpoints; OpenMAIC's Lemonade
TTS/ASR providers point here). Loopback only.

POST /v1/audio/speech          narration and live classmate lines
POST /v1/audio/transcriptions  the student's voice in a lesson ("chime in")
GET  /v1/status                engines in use and ElevenLabs credits (for Settings)

Lesson voice (Settings -> Lesson voice, file Library/settings/lesson-voice):
- kokoro (default): open voice model on this Mac (free).
- elevenlabs: the professor (narrator voice) in ElevenLabs quality; classmates stay on
  Kokoro so credits go where they matter. Falls back to Kokoro before credits run low.
- openai: OpenAI gpt-4o-mini-tts for everyone.
Any failure falls back to Kokoro, then OpenAI.

Speech to text for the student's short questions: ElevenLabs Scribe (if a key is set),
then whisper.cpp on this Mac, then OpenAI whisper-1.
"""
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

LIB = os.path.expanduser("~/Documents/Claude MacOs/Sensei/Library")
HOME = os.environ.get("SENSEI_KOKORO_DIR", os.path.join(LIB, "tools/kokoro"))
WHISPER = os.environ.get("SENSEI_WHISPER_DIR", os.path.join(LIB, "tools/whisper.cpp"))
PORT = int(os.environ.get("SENSEI_VOICE_PORT", "13305"))
SETTINGS = os.path.join(LIB, "settings")
OPENAI_KEY = os.environ.get("SENSEI_OPENAI_API_KEY", "")
ELEVEN_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# The professor's ElevenLabs voice (default: a stock warm, clear narrator voice).
ELEVEN_VOICE = os.environ.get("ELEVENLABS_PROFESSOR_VOICE_ID", "nPczCjzI2devNBz1zQrb")
ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
NARRATOR = "af_heart"  # OpenMAIC's default narrator/teacher voice for this provider
RESERVE = 0.10  # keep 10% of the month's ElevenLabs credits in reserve

kokoro = Kokoro(os.path.join(HOME, "kokoro-v1.0.onnx"), os.path.join(HOME, "voices-v1.0.bin"))
voices = set(kokoro.get_voices())
lock = threading.Lock()


def setting(name: str, allowed: tuple[str, ...], fallback: str) -> str:
    try:
        with open(os.path.join(SETTINGS, name)) as f:
            v = f.read().strip()
            return v if v in allowed else fallback
    except OSError:
        return fallback


# --- ElevenLabs credits (checked at most every 10 minutes) -------------------------------
_credits = {"at": 0.0, "used": 0, "limit": 0}


def eleven_credits() -> dict:
    if ELEVEN_KEY and time.time() - _credits["at"] > 600:
        try:
            req = urllib.request.Request("https://api.elevenlabs.io/v1/user/subscription", headers={"xi-api-key": ELEVEN_KEY})
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.loads(r.read())
            _credits.update(at=time.time(), used=int(d.get("character_count", 0)), limit=int(d.get("character_limit", 0)))
        except Exception:
            _credits["at"] = time.time()
    return _credits


def eleven_affordable(chars: int) -> bool:
    c = eleven_credits()
    if not c["limit"]:
        return bool(ELEVEN_KEY)
    return c["limit"] - c["used"] - chars > c["limit"] * RESERVE


# --- Engines -----------------------------------------------------------------------------
def kokoro_wav(text: str, voice: str, speed: float) -> bytes:
    voice = voice if voice in voices else NARRATOR
    lang = "en-gb" if voice.startswith("b") else "en-us"
    with lock:
        samples, rate = kokoro.create(text, voice=voice, speed=max(0.5, min(2.0, speed)), lang=lang)
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV")
    return buf.getvalue()


def openai_speech(text: str, voice: str, speed: float) -> bytes:
    if not OPENAI_KEY:
        raise RuntimeError("no OpenAI key")
    oa_voice = "ash" if voice.startswith(("am_", "bm_")) else "coral"
    body = json.dumps({"model": "gpt-4o-mini-tts", "input": text, "voice": oa_voice, "speed": speed, "response_format": "mp3",
                       "instructions": "Warm, clear, engaging instructor explaining respiratory therapy to a student."}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def eleven_speech(text: str, speed: float) -> bytes:
    if not ELEVEN_KEY:
        raise RuntimeError("no ElevenLabs key")
    if not eleven_affordable(len(text)):
        raise RuntimeError("ElevenLabs credits are in reserve")
    body = json.dumps({"text": text, "model_id": ELEVEN_MODEL,
                       "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.3, "speed": max(0.7, min(1.2, speed))}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}?output_format=mp3_44100_128", data=body, method="POST",
                                 headers={"xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=120) as r:
        audio = r.read()
    _credits["used"] += len(text)  # keep the local estimate current between checks
    return audio


def convert(audio: bytes, to: str) -> bytes:
    """mp3 <-> wav with ffmpeg (OpenMAIC asks for one format per provider)."""
    fmt = "mp3" if to == "mp3" else "wav"
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0"] + (["-b:a", "96k"] if fmt == "mp3" else []) + ["-f", fmt, "pipe:1"]
    return subprocess.run(args, input=audio, capture_output=True, check=True).stdout


def speech(text: str, voice: str, speed: float, fmt: str) -> tuple[bytes, str]:
    choice = setting("lesson-voice", ("kokoro", "elevenlabs", "openai"), "kokoro")
    # ElevenLabs is spent on the professor (narrator voice); classmates stay on Kokoro.
    if choice == "elevenlabs" and voice != NARRATOR:
        choice = "kokoro"
    order = [choice] + [e for e in ("kokoro", "openai") if e != choice]
    last = None
    for which in order:
        try:
            if which == "elevenlabs":
                return eleven_speech(text, speed), "mp3"
            if which == "openai":
                return openai_speech(text, voice, speed), "mp3"
            return kokoro_wav(text, voice, speed), "wav"
        except Exception as e:  # try the next engine
            last = e
    raise last or RuntimeError("no voice engine available")


# --- Speech to text (short clips from the lesson mic) --------------------------------------
def eleven_stt(audio: bytes, name: str) -> str:
    boundary = "----sensei" + str(time.time_ns())
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\neng\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="tag_audio_events"\r\n\r\nfalse\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + audio + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=b"".join(parts), method="POST",
                                 headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return str(json.loads(r.read()).get("text", "")).strip()


def local_stt(audio: bytes) -> str:
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in")
        wav = os.path.join(d, "a.wav")
        with open(src, "wb") as f:
            f.write(audio)
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav], check=True)
        out = subprocess.run([os.path.join(WHISPER, "build/bin/whisper-cli"), "-ng", "-t", "4", "-nt", "-np",
                              "-m", os.path.join(WHISPER, "models/ggml-base.en.bin"), "-f", wav,
                              "--prompt", "Respiratory therapy class question."], capture_output=True, text=True, check=True, timeout=120)
        return " ".join(out.stdout.split()).strip()


def openai_stt(audio: bytes, name: str) -> str:
    boundary = "----sensei" + str(time.time_ns())
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return str(json.loads(r.read()).get("text", "")).strip()


def transcribe(audio: bytes, name: str) -> str:
    engines = []
    if ELEVEN_KEY:
        engines.append(lambda: eleven_stt(audio, name))
    engines.append(lambda: local_stt(audio))
    if OPENAI_KEY:
        engines.append(lambda: openai_stt(audio, name))
    last = None
    for run in engines:
        try:
            return run()
        except Exception as e:
            last = e
    raise last or RuntimeError("no transcriber available")


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
        path = self.path.rstrip("/")
        if path.endswith("/models"):
            return self.send(200, json.dumps({"object": "list", "data": [{"id": "kokoro-v1", "object": "model"}, {"id": "Whisper-Base", "object": "model"}]}).encode())
        if path.endswith("/status"):
            c = eleven_credits() if ELEVEN_KEY else None
            return self.send(200, json.dumps({
                "lessonVoice": setting("lesson-voice", ("kokoro", "elevenlabs", "openai"), "kokoro"),
                "elevenlabs": {"used": c["used"], "limit": c["limit"]} if c else None,
                "openai": bool(OPENAI_KEY),
            }).encode())
        self.send(404, b'{"error":{"message":"Not found"}}')

    def do_POST(self):
        path = self.path.rstrip("/")
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            if path.endswith("/audio/speech"):
                body = json.loads(raw or b"{}")
                text = str(body.get("input", "")).strip()
                if not text:
                    return self.send(400, b'{"error":{"message":"input is required"}}')
                want = str(body.get("response_format", "wav")).lower()
                audio, got = speech(text, str(body.get("voice", NARRATOR)), float(body.get("speed", 1.0) or 1.0), want)
                if got != ("mp3" if want == "mp3" else "wav"):
                    audio = convert(audio, want)
                return self.send(200, audio, "audio/mpeg" if want == "mp3" else "audio/wav")
            if path.endswith("/audio/transcriptions"):
                msg = BytesParser(policy=email_policy).parsebytes(
                    b"Content-Type: " + self.headers.get("Content-Type", "").encode() + b"\r\n\r\n" + raw)
                audio, name = None, "audio.wav"
                for part in msg.iter_parts():
                    if part.get_param("name", header="content-disposition") == "file":
                        audio = part.get_payload(decode=True)
                        name = part.get_filename() or name
                if not audio:
                    return self.send(400, b'{"error":{"message":"file is required"}}')
                return self.send(200, json.dumps({"text": transcribe(audio, name)}).encode())
            self.send(404, b'{"error":{"message":"Not found"}}')
        except Exception as e:  # report, don't crash the service
            self.send(500, json.dumps({"error": {"message": str(e)[:300]}}).encode())


if __name__ == "__main__":
    print(f"Sensei voice on 127.0.0.1:{PORT}: Kokoro ({len(voices)} voices), ElevenLabs {'on' if ELEVEN_KEY else 'off'}, OpenAI {'on' if OPENAI_KEY else 'off'}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
