"""Tests for the ASR model switch in full-hub/asr_api.py.

The real models are large, so these tests replace funasr.AutoModel and the
silero VAD loader with fakes. Each case runs asr_api.py in a fresh Python
process, because the module reads its settings at import time.

Run from the repo root:  python -m pytest full-hub/tests -q
Needs: pytest, fastapi, httpx, numpy, soundfile, torch, python-multipart, modelscope
"""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

FULL_HUB = Path(__file__).resolve().parents[1]

RUNNER = textwrap.dedent(r'''
    import io, json, os, sys, types
    import numpy as np
    import soundfile as sf
    import torch

    calls = {"init": [], "generate": []}

    class FakeModel:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            calls["init"].append({k: v for k, v in kwargs.items() if isinstance(v, (str, bool, int))})

        def generate(self, **kwargs):
            audio = kwargs.get("input")
            calls["generate"].append({
                "model": self.kwargs.get("model"),
                "input_type": type(audio).__name__,
                "input_dtype": str(getattr(audio, "dtype", "")),
                **{k: v for k, v in kwargs.items() if k != "input" and isinstance(v, (str, bool, int))},
            })
            if self.kwargs.get("model") == "iic/SenseVoiceSmall":
                return [{"key": "x", "text": os.environ.get("FAKE_TEXT", "")}]
            if self.kwargs.get("model") == "paraformer-zh":
                return [{"key": "x", "text": "ni hao"}]
            return [{"key": "x", "text": "ni hao, punctuated."}]

    fake_funasr = types.ModuleType("funasr")
    fake_funasr.AutoModel = FakeModel
    sys.modules["funasr"] = fake_funasr

    os.makedirs(os.path.join("asr-hub", "model", "torch_hub", "snakers4_silero-vad_master"), exist_ok=True)
    torch.hub.load = lambda *args, **kwargs: (lambda audio, sr: torch.tensor(0.0), None)

    sys.path.insert(0, os.environ["FULL_HUB"])
    import asr_api
    from fastapi.testclient import TestClient

    buf = io.BytesIO()
    sf.write(buf, np.zeros(16000, dtype=np.float32), 16000, format="WAV")

    with TestClient(asr_api.app) as client:
        response = client.post("/v1/upload_audio", files={"file": ("recording.wav", buf.getvalue(), "audio/wav")})

    sys.__stdout__.write("RESULT:" + json.dumps({
        # getattr: the upstream file has no model switch and is always paraformer-zh
        "asr_model": getattr(asr_api, "ASR_MODEL", "paraformer-zh"),
        "asr_language": getattr(asr_api, "ASR_LANGUAGE", None),
        "punc_loaded": asr_api.model_state["punc_model"] is not None,
        "calls": calls,
        "response": response.json(),
    }) + "\n")
''')


def run_asr(tmp_path, **env):
    full_env = {**os.environ, "FULL_HUB": str(FULL_HUB), **env}
    for key in ("MY_NEURO_ASR_MODEL", "MY_NEURO_ASR_LANGUAGE"):
        if key not in env:
            full_env.pop(key, None)
    proc = subprocess.run(
        [sys.executable, "-c", RUNNER],
        cwd=tmp_path, env=full_env, capture_output=True, text=True, timeout=300,
    )
    lines = [line for line in proc.stdout.splitlines() if line.startswith("RESULT:")]
    assert lines, f"runner failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    return json.loads(lines[-1][len("RESULT:"):])


def test_default_is_sensevoice_and_strips_tags(tmp_path):
    result = run_asr(tmp_path, FAKE_TEXT="<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello there, how are you?")
    assert result["asr_model"] == "sensevoice"
    assert result["response"] == {"status": "success", "filename": "recording.wav", "text": "Hello there, how are you?"}
    assert [c["model"] for c in result["calls"]["init"]] == ["iic/SenseVoiceSmall"]
    assert result["calls"]["init"][0]["disable_update"] is True
    assert result["punc_loaded"] is False
    generate = result["calls"]["generate"][0]
    assert generate["language"] == "auto"
    assert generate["use_itn"] is True
    assert generate["input_type"] == "ndarray" and generate["input_dtype"] == "float32"


def test_language_hint_is_passed(tmp_path):
    result = run_asr(tmp_path, MY_NEURO_ASR_LANGUAGE="EN", FAKE_TEXT="<|en|><|HAPPY|><|Speech|><|withitn|>Hi!")
    assert result["asr_language"] == "en"
    assert result["calls"]["generate"][0]["language"] == "en"
    assert result["response"]["text"] == "Hi!"


def test_empty_transcript_is_an_error(tmp_path):
    result = run_asr(tmp_path, FAKE_TEXT="<|nospeech|><|EMO_UNKNOWN|><|Event_UNK|><|woitn|>")
    assert result["response"]["status"] == "error"


def test_unknown_model_falls_back_to_sensevoice(tmp_path):
    result = run_asr(tmp_path, MY_NEURO_ASR_MODEL="whisper-large", FAKE_TEXT="<|en|>ok")
    assert result["asr_model"] == "sensevoice"
    assert result["response"]["text"] == "ok"


def test_paraformer_keeps_upstream_behavior(tmp_path):
    result = run_asr(tmp_path, MY_NEURO_ASR_MODEL="paraformer-zh")
    assert result["asr_model"] == "paraformer-zh"
    assert [c["model"] for c in result["calls"]["init"]] == [
        "paraformer-zh",
        "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
    ]
    assert result["punc_loaded"] is True
    assert result["response"] == {"status": "success", "filename": "recording.wav", "text": "ni hao, punctuated."}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
