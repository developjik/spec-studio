#!/usr/bin/env python3
"""A model server that answers in the provider dialects the daemon speaks.

It is not a model: it reads the pins out of the prompt and drafts what a
careful person would draft from them — a policy for a policy pin, a contract
for a data pin, a requirement and a QA case for an exception. That is enough
to exercise the whole wire: request shape, JSON-in-prose parsing, schema
validation, pin citation, the decision card, adopt and revert.

Two endpoints, because the daemon supports two providers:
  POST /v1/chat/completions   OpenAI-compatible
  POST /v1/messages           Anthropic Messages

Usage: python3 test/e2e/mock_llm.py [port]
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PIN_LINE = re.compile(r"^#(\d+) \[([a-z_]+)\] (.+)$", re.MULTILINE)
BLOCK_LINE = re.compile(r"^- (B_[A-Za-z0-9_-]{8,24}) · ([a-z]+) · (.+)$", re.MULTILINE)


def numbered_links(counter: list[int]) -> str:
    counter[0] += 1
    return f"n{counter[0]}"


def graph_draft(prompt: str) -> dict:
    # A pin line reads "#1 [policy] 제목 — 본문": the title ends at the dash.
    pins = [
        (int(number), kind, title.split(" — ")[0].strip())
        for number, kind, title in PIN_LINE.findall(prompt)
    ]
    nodes: list[dict] = []
    links: list[dict] = []
    counter = [0]

    for number, kind, title in pins[:12]:
        key = numbered_links(counter)
        if kind in ("policy", "permission"):
            nodes.append(
                {
                    "key": key,
                    "type": "policy",
                    "title": title[:60],
                    "body": f"{title} 조건이 성립할 때만 이 동작이 허용된다.",
                    "pins": [number],
                }
            )
            links.append({"type": "governs", "src": f"item:{key}", "dst": f"pin:{number}"})
        elif kind == "data":
            nodes.append(
                {
                    "key": key,
                    "type": "contract",
                    "title": title[:60],
                    "body": f"{title}의 컬럼·타입·허용값을 정의한다.",
                    "pins": [number],
                }
            )
            links.append({"type": "derived_from", "src": f"item:{key}", "dst": f"pin:{number}"})
        elif kind == "exception":
            req = f"{key}-req"
            qa = f"{key}-qa"
            nodes.append(
                {
                    "key": req,
                    "type": "req",
                    "title": f"예외: {title}"[:60],
                    "body": f"{title} 상황에서 사용자는 이유와 다음 행동을 볼 수 있어야 한다.",
                    "pins": [number],
                }
            )
            nodes.append(
                {
                    "key": qa,
                    "type": "qa",
                    "title": f"#{number} {title} 예외 확인"[:60],
                    "body": (
                        f"사전조건: {title}\n"
                        "기대 결과: 안내 문구와 복구 경로가 보인다.\n"
                        "판정: 통과 / 실패 / 차단"
                    ),
                    "pins": [number],
                }
            )
            links.append({"type": "handles_edge", "src": f"pin:{number}", "dst": f"item:{req}"})
            links.append({"type": "verifies", "src": f"item:{qa}", "dst": f"pin:{number}"})
            links.append({"type": "verifies", "src": f"item:{qa}", "dst": f"item:{req}"})
        else:
            req = f"{key}-req"
            qa = f"{key}-qa"
            nodes.append(
                {
                    "key": req,
                    "type": "req",
                    "title": title[:60],
                    "body": f"{title} 동작이 제공된다.",
                    "pins": [number],
                }
            )
            nodes.append(
                {
                    "key": qa,
                    "type": "qa",
                    "title": f"#{number} {title} 동작 확인"[:60],
                    "body": (
                        f"사전조건: {title}\n"
                        "기대 결과: 정상 흐름에서 동작한다.\n"
                        "판정: 통과 / 실패 / 차단"
                    ),
                    "pins": [number],
                }
            )
            links.append({"type": "implements", "src": f"pin:{number}", "dst": f"item:{req}"})
            links.append({"type": "verifies", "src": f"item:{qa}", "dst": f"pin:{number}"})
            links.append({"type": "verifies", "src": f"item:{qa}", "dst": f"item:{req}"})

    if not nodes:
        nodes = [
            {
                "key": "n1",
                "type": "req",
                "title": "화면 동작 정리",
                "body": "핀에서 읽은 동작을 요구사항으로 정리한다.",
                "pins": [],
            }
        ]

    return {
        "summary": f"핀 {len(pins)}개에서 초안 {len(nodes)}개를 만들었습니다.",
        "nodes": nodes[:12],
        "links": links[:24],
    }


def doc_draft(prompt: str) -> dict:
    blocks = BLOCK_LINE.findall(prompt)
    pins = [(int(number), kind, title) for number, kind, title in PIN_LINE.findall(prompt)]
    if not blocks:
        return {"summary": "고칠 문단이 없습니다.", "patches": []}
    block_id, _kind, text = blocks[0]
    if pins:
        number, _pin_kind, title = pins[0]
        new_text = f"{text.split('.')[0]}. {title} 조건을 문단에 반영한다."
        cited = [number]
    else:
        new_text = f"{text} (핀 기준으로 다시 정리)"
        cited = []
    return {
        "summary": "첫 문단을 핀과 맞춥니다.",
        "patches": [{"blockId": block_id, "text": new_text, "pins": cited}],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401 - quieter log
        sys.stderr.write("mock-llm " + fmt % args + "\n")

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        body = json.loads(raw)

        if self.headers.get("x-api-key") in (None, "") and not str(
            self.headers.get("authorization", "")
        ).startswith("Bearer "):
            self._send(401, {"error": {"message": "missing credentials"}})
            return

        if self.path.startswith("/v1/messages"):
            system = body.get("system", "")
            messages = body.get("messages", [])
            prompt = messages[0]["content"] if messages else ""
        else:
            messages = body.get("messages", [])
            system = next((m["content"] for m in messages if m.get("role") == "system"), "")
            prompt = next((m["content"] for m in messages if m.get("role") == "user"), "")

        if "health check" in system:
            content = '{"ok":true}'
        elif "문단 (id · 타입 · 본문)" in prompt:
            content = json.dumps(doc_draft(prompt), ensure_ascii=False)
        else:
            content = json.dumps(graph_draft(prompt), ensure_ascii=False)

        if self.path.startswith("/v1/messages"):
            self._send(200, {"content": [{"type": "text", "text": content}], "model": body.get("model")})
        else:
            self._send(200, {"choices": [{"message": {"role": "assistant", "content": content}}]})

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock-llm listening on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
