#!/usr/bin/env python3
"""End-to-end check for the AI proposal layer (v1 phase 2).

A real daemon, a real SQLite file, a real built app served by `vite preview`,
and a mock model server that speaks both provider dialects. The browser is
driven at 1440×900 through the whole promise:

  1. AI 설정에 모의 Endpoint·모델·키를 넣고 연결 확인
  2. 제안 추출 → 모의 모델의 초안이 `LLM 제안` 배지가 붙은 결정 카드 1장으로
  3. 채택 → 그래프 객체·링크 생성, 되돌리기 → op_log.before로 원복
  4. 문서 문단 제안도 같은 카드·같은 되돌리기로 동작
  5. 키는 SQLite 파일에도 데몬 로그에도 남지 않는다

Environment (set by the runner):
  SPEC_STUDIO_DB   the SQLite file the daemon owns
  WEB_URL          default http://127.0.0.1:5173
  MOCK_LLM_URL     default http://127.0.0.1:8799
  OUT_DIR          where screenshots go (default: downloads)
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from diagnostics import capturing_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("SPEC_STUDIO_NODE", "node")
DB = os.environ["SPEC_STUDIO_DB"]
DAEMON_PORT = int(os.environ.get("DAEMON_PORT", "8787"))
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
MOCK_LLM_URL = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:8799")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/p2e2e/daemon.log"))
API_KEY = "sk-e2e-secret-7f3a"
MODEL = "mock-1"

OUT_DIR.mkdir(parents=True, exist_ok=True)


def start_daemon() -> subprocess.Popen:
    env = os.environ.copy()
    env["SPEC_STUDIO_PORT"] = str(DAEMON_PORT)
    env["SPEC_STUDIO_DB"] = DB
    # No keys in the environment: the browser supplies one, which is the path
    # that must not persist. (The env fallback is covered by unit tests.)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("OPENAI_API_KEY", None)
    DAEMON_LOG.parent.mkdir(parents=True, exist_ok=True)
    log = DAEMON_LOG.open("a")
    process = subprocess.Popen(
        [NODE, str(DAEMON)],
        cwd=str(ROOT),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{DAEMON_PORT}/api/health", timeout=0.5):
                return process
        except Exception:
            time.sleep(0.1)
    raise SystemExit("daemon did not become healthy")


def query(sql: str, params: tuple = ()) -> list[tuple]:
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return connection.execute(sql, params).fetchall()
    finally:
        connection.close()


def graph_state() -> dict:
    nodes = query(
        "SELECT id, kind, subtype, title FROM obj "
        "WHERE deleted_at IS NULL AND ((kind='specnode' AND subtype IN ('requirement','policy')) "
        "OR kind IN ('contract','verification')) ORDER BY rowid"
    )
    links = query("SELECT id, type, src, dst FROM link ORDER BY rowid")
    cards = query("SELECT id, state, payload FROM graph_proposal ORDER BY rowid DESC")
    return {"nodes": nodes, "links": links, "cards": cards}


def main() -> int:
    daemon = start_daemon()
    failures: list[str] = []

    def check(label: str, condition: bool, detail: str = "") -> None:
        print(f"{'OK  ' if condition else 'FAIL'} {label}{'' if condition else f' — {detail}'}")
        if not condition:
            failures.append(label)

    try:
        with capturing_playwright(OUT_DIR) as playwright:
            browser = playwright.chromium.launch(
                executable_path=CHROMIUM if Path(CHROMIUM).exists() else None,
                chromium_sandbox=False,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            )
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            console_errors: list[str] = []
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            # ── 0. the daemon knows it has no key of its own ────────────
            with urllib.request.urlopen(f"http://127.0.0.1:{DAEMON_PORT}/api/ai", timeout=5) as response:
                status = json.loads(response.read())["status"]
            env_keys = {
                entry["provider"]: entry["hasEnvKey"] for entry in status["providers"]
            }
            check("데몬 환경변수 키 없음 (UI 키로만)", env_keys == {"anthropic": False, "openai": False, "local": False}, str(env_keys))

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )

            # ── 1. a screen with three pins of three families ──────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            stage = page.locator("[data-testid=stage]").bounding_box()
            assert stage is not None
            for fx, fy, kind, title, body in [
                (0.22, 0.30, "policy", "배송 시작 후 취소 불가", "사전조건: 배송 시작"),
                (0.56, 0.48, "exception", "재고 없음 안내", "재고 0이면 버튼 비활성, 재입고 알림 제안"),
                (0.78, 0.66, "function", "취소 요청", "배송 준비 중일 때만 활성"),
            ]:
                page.mouse.click(stage["x"] + stage["width"] * fx, stage["y"] + stage["height"] * fy)
                page.locator("[data-testid=pin-title]").fill(title)
                page.locator("[data-testid=pin-body]").fill(body)
                page.locator(f"[data-testid=type-{kind}]").click()
                page.locator("[data-testid=pin-save]").click()
                page.wait_for_timeout(250)
            page.wait_for_selector("[data-testid=pin-3]", timeout=5000)

            # ── 2. AI 설정: mock endpoint, model, key, 연결 확인 ────────
            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-provider]").select_option("openai")
            page.locator("[data-testid=ai-model]").fill(MODEL)
            page.locator("[data-testid=ai-endpoint]").fill(f"{MOCK_LLM_URL}/v1")
            page.locator("[data-testid=ai-key]").fill(API_KEY)
            page.locator("[data-testid=ai-test]").click()
            page.wait_for_selector("[data-testid=ai-status][data-state=ok]", timeout=20000)
            connection = page.locator("[data-testid=ai-status]").inner_text()
            check("AI 설정 연결 확인", "연결 정상" in connection, connection)
            page.screenshot(path=str(OUT_DIR / "spec-studio-v1-p2-settings.png"))

            # ── 3. 제안 추출 → LLM 제안 배지가 붙은 결정 카드 1장 ──────
            page.locator("[data-testid=ai-extract-graph]").click()
            page.wait_for_selector("[data-testid=graph-proposal-card]", timeout=30000)
            page.wait_for_selector("[data-testid=view-graph][aria-selected=true]", timeout=5000)
            source = page.locator("[data-testid=graph-proposal-source]")
            badge = source.inner_text()
            check(
                "카드에 LLM 제안 배지",
                source.get_attribute("data-source") == "llm" and "LLM 제안" in badge,
                f"{source.get_attribute('data-source')} / {badge}",
            )
            check("배지에 프로바이더·모델", "openai" in badge and MODEL in badge, badge)
            items = page.locator("[data-testid=graph-proposal-item]").count()
            summary = page.locator("[data-testid=graph-proposal-summary]").inner_text()
            check("모의 LLM 초안이 카드에 표시", items >= 3, f"{items}건 · {summary}")
            check("카드 링크 수 표시", "링크" in page.locator("[data-testid=graph-proposal-links]").inner_text())
            page.wait_for_timeout(400)
            shot = OUT_DIR / "spec-studio-v1-p2-llm.png"
            page.screenshot(path=str(shot))
            check("스크린샷 저장", shot.exists(), str(shot))

            card = graph_state()["cards"][0]
            payload = json.loads(card[2])
            check("DB 카드가 llm 출처로 기록", payload.get("source") == "llm" and payload.get("model") == MODEL, str(payload.get("source")))
            check("카드가 열린 상태", card[1] == "open", card[1])

            # ── 4. 채택 → 되돌리기 ─────────────────────────────────────
            page.locator("[data-testid=graph-proposal-adopt]").click()
            page.wait_for_selector("[data-testid=graph-proposal-revert]", timeout=10000)
            adopted = graph_state()
            check("채택 → 객체 생성", len(adopted["nodes"]) >= 3, str(adopted["nodes"]))
            check("채택 → 링크 생성", len(adopted["links"]) >= 3, str(adopted["links"]))
            check(
                "채택 → op_log 기록",
                len(query("SELECT seq FROM op_log WHERE kind='graph.proposal.adopt'")) == 1,
            )

            page.locator("[data-testid=graph-proposal-revert]").click()
            page.wait_for_timeout(1200)
            reverted = graph_state()
            check("되돌리기 → 객체 0개", len(reverted["nodes"]) == 0, str(reverted["nodes"]))
            check("되돌리기 → 링크 0개", len(reverted["links"]) == 0, str(reverted["links"]))
            check(
                "되돌리기 → op_log 기록",
                len(query("SELECT seq FROM op_log WHERE kind='graph.proposal.revert'")) == 1,
            )

            # ── 5. 문서 문단 제안도 같은 카드로 ─────────────────────────
            page.locator("[data-testid=view-studio]").click()
            page.wait_for_selector("[data-testid=doc-add]", timeout=5000)
            page.locator("[data-testid=doc-add]").click()
            page.wait_for_selector("[data-testid=doc-text-1]", timeout=5000)
            page.locator("[data-testid=doc-text-1]").fill("취소는 언제든 가능하다.")
            page.locator("[data-testid=doc-text-1]").press("Tab")
            page.wait_for_timeout(500)

            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-extract-doc]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            doc_source = page.locator("[data-testid=proposal-source]")
            check(
                "문서 카드에 LLM 제안 배지",
                doc_source.get_attribute("data-source") == "llm",
                str(doc_source.get_attribute("data-source")),
            )
            before_text = query("SELECT text FROM block WHERE state='live' ORDER BY rowid")[0][0]
            page.screenshot(path=str(OUT_DIR / "spec-studio-v1-p2-doc.png"))

            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_selector("[data-testid=proposal-revert]", timeout=10000)
            after_text = query("SELECT text FROM block WHERE state='live' ORDER BY rowid")[0][0]
            check("문단 제안 채택 → 본문 갱신", after_text != before_text, after_text)
            check("채택 문단이 핀을 인용", "[핀] #1" in after_text, after_text)

            page.locator("[data-testid=proposal-revert]").click()
            page.wait_for_timeout(1200)
            restored = query("SELECT text FROM block WHERE state='live' ORDER BY rowid")[0][0]
            check("문단 되돌리기 → 정확히 원문", restored == before_text, f"{restored!r}")

            # ── 6. the key is nowhere on disk ──────────────────────────
            raw_db = Path(DB).read_bytes()
            check("SQLite 파일에 키 없음", API_KEY.encode() not in raw_db)
            check("SQLite 파일에 모델명 없음", MODEL.encode() not in raw_db)
            log_text = DAEMON_LOG.read_text(errors="ignore") if DAEMON_LOG.exists() else ""
            check("데몬 로그에 키 없음", API_KEY not in log_text)

            check("콘솔 오류 0건", console_errors == [], " | ".join(console_errors[:3]))
            if failures:
                page.screenshot(path=str(OUT_DIR / "failure-checks.png"))
            browser.close()
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=10)
        except Exception:
            daemon.kill()

    if failures:
        print(f"\nFAILED: {len(failures)} — {', '.join(failures)}")
        return 1
    print("\nPASS: AI 제안 end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
