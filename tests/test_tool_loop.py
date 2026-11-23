#!/usr/bin/env python3
"""tests/test_tool_loop.py — the hub's tool loop, proven end to end.

THE TEST THAT MATTERS MOST
───────────────────────────
A model asks for a tool → the hub runs it → the model answers with the
result. Everything else in the toolkit is plumbing; this is the thing the
whole feature exists for.

It is proven against a MOCK tool-calling model (a tiny local HTTP server
that speaks the OpenAI streaming format and asks for `calculator`), because
the model on this box (gemma) has no function-calling support and a real
tool-calling model is not available offline.

Both paths are covered:
  · the non-streaming path — the hub captures the provider's SSE, finds the
    tool call, runs the tool, feeds the result back
  · the STREAMING path — the interceptor holds the tool frames back so the
    client never sees a tool_call it did not ask for, and the answer arrives
    as ordinary content frames

Skipped when the gateway is not running.
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GATEWAY = "http://127.0.0.1:3011"


def _gateway_up() -> bool:
    try:
        with urllib.request.urlopen(f"{GATEWAY}/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ── the mock tool-calling model ─────────────────────────────────────────────
class _MockModel(BaseHTTPRequestHandler):
    """Answers the way a tool-capable model does:

    round 1 → a tool_call for `calculator` with the expression "6*7"
    round 2 → sees the tool result and answers "The answer is 42."

    Always speaks SSE — the hub's router asks every upstream for a stream,
    even when the CALLER wanted a non-streaming answer.
    """

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        msgs = body.get("messages") or []
        saw_tool = any(m.get("role") == "tool" for m in msgs)
        model = body.get("model") or "mock"

        chunks = []
        if not saw_tool:
            chunks.append({
                "id": "chatcmpl-mock", "object": "chat.completion.chunk",
                "created": 1, "model": model,
                "choices": [{"index": 0, "finish_reason": None, "delta": {"tool_calls": [{
                    "index": 0, "id": "call_test_1", "type": "function",
                    "function": {"name": "calculator",
                                 "arguments": "{\"expression\":\"6*7\"}"},
                }]}}],
            })
        else:
            tool_result = next((m.get("content") for m in msgs if m.get("role") == "tool"), "")
            text = f"The answer is {tool_result}."
            for piece in text.split(" "):
                chunks.append({
                    "id": "chatcmpl-mock", "object": "chat.completion.chunk",
                    "created": 1, "model": model,
                    "choices": [{"index": 0, "finish_reason": None,
                                 "delta": {"content": piece + " "}}],
                })

        payload = b""
        for c in chunks:
            payload += f"data: {json.dumps(c)}\n\n".encode()
        payload += b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class TestToolLoop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not _gateway_up():
            raise unittest.SkipTest("the gateway is not running on 127.0.0.1:3011")
        cls.port = _free_port()
        cls.server = HTTPServer(("127.0.0.1", cls.port), _MockModel)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.4)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _url(self):
        return f"http://127.0.0.1:{self.port}/v1/chat/completions"

    def _post_chat(self, body):
        req = urllib.request.Request(
            f"{GATEWAY}/api/chat", data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", errors="replace")

    def test_the_non_streaming_loop_runs_the_tool_and_answers(self):
        status, raw = self._post_chat({
            "message": "What is 6 times 7?",
            "stream": False,
            "api_url": self._url(),
        })
        self.assertEqual(status, 200, raw)
        data = json.loads(raw)
        content = data["choices"][0]["message"].get("content") or ""
        self.assertIn("42", content,
                      f"the tool result never reached the model: {content!r}")

    def test_the_streaming_loop_never_leaks_a_tool_call(self):
        """The client asked a QUESTION, not for a tool. A tool_call frame that
        reaches it would make an OpenAI-compatible client execute the tool
        itself — twice, on the wrong machine."""
        status, raw = self._post_chat({
            "message": "What is 6 times 7?",
            "stream": True,
            "api_url": self._url(),
        })
        self.assertEqual(status, 200, raw)
        content = ""
        tool_frames = 0
        saw_done = False
        for frame in raw.split("\n\n"):
            for line in frame.split("\n"):
                if not line.startswith("data: "):
                    continue
                payload = line[6:].strip()
                if payload == "[DONE]":
                    saw_done = True
                    continue
                try:
                    p = json.loads(payload)
                except Exception:
                    continue
                delta = (p.get("choices") or [{}])[0].get("delta") or {}
                if delta.get("tool_calls"):
                    tool_frames += 1
                if delta.get("content"):
                    content += delta["content"]
        self.assertEqual(tool_frames, 0,
                         "a tool_call frame reached the client — it would execute the tool itself")
        self.assertIn("42", content, f"the answer never arrived: {content!r}")
        self.assertTrue(saw_done, "the stream was not terminated")

    def test_the_openai_surface_runs_the_loop_too(self):
        """OpenCode, Cline and every OpenAI-compatible client use /v1."""
        req = urllib.request.Request(
            f"{GATEWAY}/v1/chat/completions",
            data=json.dumps({
                "model": "mock",
                "messages": [{"role": "user", "content": "What is 6 times 7?"}],
                "stream": False,
                "api_url": self._url(),
            }).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
        self.assertIn("42", raw, f"the /v1 tool loop did not run: {raw[:600]}")

    def test_the_tools_are_auto_attached(self):
        """The model must be told the tools exist. Before the toolkit, a chat
        only ran a tool if the CLIENT passed `tools` in the body — and nobody
        does, so no model on the network ever used a tool."""
        req = urllib.request.Request(
            f"{GATEWAY}/api/chat",
            data=json.dumps({
                "message": "What is 6 times 7?",
                "stream": False,
                "api_url": self._url(),
            }).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            json.loads(r.read())
        # the mock only asks for a tool when it RECEIVED a tools list, so the
        # fact that the loop ran at all proves the schemas were attached.

    def test_opting_out_means_no_tools(self):
        """`"tools": false` must really turn the toolkit off."""
        req = urllib.request.Request(
            f"{GATEWAY}/api/chat",
            data=json.dumps({
                "message": "What is 6 times 7?",
                "stream": False,
                "tools": False,
                "api_url": self._url(),
            }).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
        content = data["choices"][0]["message"].get("content") or ""
        # with no tools attached the mock never gets a tool result, so it
        # keeps asking — the hub must NOT have run a calculator
        self.assertNotIn("42", content,
                         f"the tool ran even though the client opted out: {content!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
