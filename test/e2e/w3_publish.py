#!/usr/bin/env python3
"""End-to-end check for W3 (daemon + SQLite + Confluence publish).

Runs a real daemon, a real web build served by Vite, and a Confluence-shaped
mock, then drives the browser at 1440×900:

  1. sample screen + Figma URL + three pins → rows in the SQLite file
  2. daemon restart + reload → the same pins and link come back
  3. publishing creates one page and three attachments, shown in the UI history
  4. publishing the same spec again creates no second page

Environment (set by the runner):
  SPEC_STUDIO_DB   the SQLite file the daemon owns
  MOCK_STATE_FILE  JSON written by the mock process: {"url": ...}
  WEB_URL          default http://localhost:5173
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

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("SPEC_STUDIO_NODE", "node")
DB = os.environ["SPEC_STUDIO_DB"]
MOCK = json.loads(Path(os.environ["MOCK_STATE_FILE"]).read_text())
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/w3e2e/daemon.log"))

OUT_DIR.mkdir(parents=True, exist_ok=True)


def mock_state() -> dict:
    with urllib.request.urlopen(f"{MOCK['url']}/__state", timeout=5) as response:
        return json.loads(response.read().decode())


def start_daemon() -> subprocess.Popen:
    env = os.environ.copy()
    env["SPEC_STUDIO_PORT"] = "8787"
    env["SPEC_STUDIO_DB"] = DB
    DAEMON_LOG.parent.mkdir(parents=True, exist_ok=True)
    log = DAEMON_LOG.open("a")
    process = subprocess.Popen(
        [NODE, str(DAEMON)],
        cwd=str(ROOT),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    for _ in range(80):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8787/api/health", timeout=0.5):
                return process
        except Exception:
            time.sleep(0.1)
    raise SystemExit("daemon did not become healthy")


def sqlite_state() -> dict:
    uri = f"file:{DB}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        screen = connection.execute(
            "SELECT props FROM obj WHERE kind = 'screen' AND deleted_at IS NULL"
        ).fetchall()
        pins = connection.execute(
            "SELECT prop.value FROM obj, json_each(obj.props, '$.number') AS prop "
            "WHERE obj.kind = 'pin' AND obj.deleted_at IS NULL ORDER BY prop.value"
        ).fetchall()
        publishes = connection.execute(
            "SELECT status, space_key, page_id, spec_hash FROM publish_record ORDER BY at"
        ).fetchall()
        return {
            "screens": len(screen),
            "figma": json.loads(screen[0][0]).get("figmaUrl") if screen else None,
            "pins": [row[0] for row in pins],
            "publishes": publishes,
        }
    finally:
        connection.close()


def main() -> int:
    daemon = start_daemon()
    failures: list[str] = []

    def check(label: str, condition: bool, detail: str = "") -> None:
        print(f"{'OK  ' if condition else 'FAIL'} {label}{'' if condition else f' — {detail}'}")
        if not condition:
            failures.append(label)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=CHROMIUM if Path(CHROMIUM).exists() else None,
                chromium_sandbox=False,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            )
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            console_errors: list[str] = []
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector('[data-testid=daemon-status][data-status=connected]', timeout=20000)
            check("SQLite 데몬에 연결됨 배지", True)

            # ── 1. sample screen, Figma frame, three pins ─────────────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)

            figma = "https://www.figma.com/design/AbCdEf123/Shop?node-id=12-34"
            page.locator("[data-testid=figma-register]").click()
            page.locator("[data-testid=figma-url-input]").fill(figma)
            page.locator("[data-testid=figma-save]").click()
            page.wait_for_selector("[data-testid=figma-link]", timeout=5000)
            check("Figma 프레임 링크 등록", True)

            stage = page.locator("[data-testid=stage]").bounding_box()
            if stage is None:
                raise SystemExit("stage is not laid out")
            pins = [
                (0.22, 0.30, "function", "취소 요청", "배송 준비 중일 때만 활성"),
                (0.56, 0.48, "policy", "배송 시작 후 취소 불가", "사전조건: 배송 시작"),
                (0.78, 0.66, "exception", "재고 없음 안내", "재고 0이면 버튼 비활성"),
            ]
            for fx, fy, kind, title, body in pins:
                page.mouse.click(stage["x"] + stage["width"] * fx, stage["y"] + stage["height"] * fy)
                page.locator("[data-testid=pin-title]").fill(title)
                page.locator("[data-testid=pin-body]").fill(body)
                page.locator(f"[data-testid=type-{kind}]").click()
                page.locator("[data-testid=pin-save]").click()
                page.wait_for_timeout(350)
            page.wait_for_selector("[data-testid=pin-3]", timeout=5000)
            check("번호 핀 3개 생성", page.locator("[data-testid=pin-1]").count() == 1)

            state = sqlite_state()
            check("SQLite에 핀 3개 저장", state["pins"] == [1, 2, 3], str(state["pins"]))
            check("SQLite에 Figma 링크 저장", state["figma"] == figma, str(state["figma"]))
            page.screenshot(path=str(OUT_DIR / "spec-studio-w3-studio.png"))

            # ── 2. daemon restart, page reload ────────────────────────────
            daemon.terminate()
            daemon.wait(timeout=15)
            daemon = start_daemon()
            page.reload(wait_until="networkidle")
            page.wait_for_selector('[data-testid=daemon-status][data-status=connected]', timeout=20000)
            page.wait_for_selector("[data-testid=pin-3]", timeout=10000)
            restored = page.locator("[data-testid=figma-link]").inner_text()
            check("재기동 후 핀 복원", page.locator("[data-testid=pin-1]").count() == 1)
            check("재기동 후 Figma 링크 복원", restored == figma, restored)

            # ── 3. publish ────────────────────────────────────────────────
            page.locator("[data-testid=open-publish]").click()
            page.wait_for_selector("[data-testid=publish-modal]", timeout=5000)
            page.locator("[data-testid=publish-base-url]").fill(MOCK["url"])
            page.locator("[data-testid=publish-space]").fill("SPEC")
            page.locator("[data-testid=publish-email]").fill("dev@example.com")
            page.locator("[data-testid=publish-token]").fill("e2e-token-value")
            page.wait_for_selector("[data-testid=publish-preview]", timeout=15000)
            plan = page.locator("[data-testid=publish-preview-plan]").get_attribute("data-plan")
            check("미리보기: 새 페이지 생성", plan == "create", str(plan))
            attachments = page.locator("[data-testid=publish-attachments] li").count()
            check("미리보기: 첨부 3종", attachments == 3, str(attachments))
            body_text = page.locator("[data-testid=publish-body]").inner_text()
            check("미리보기 본문에 Figma 링크", figma.replace("&", "&amp;") in body_text)
            page.screenshot(path=str(OUT_DIR / "spec-studio-w3-publish-preview.png"))

            page.locator("[data-testid=publish-run]").click()
            page.wait_for_selector(
                "[data-testid=publish-result-status]:has-text('새 페이지를 만들었습니다')", timeout=45000
            )
            state = mock_state()
            check("Confluence 페이지 1건 생성", state["pageCreates"] == 1, str(state["pageCreates"]))
            check(
                "첨부 3종 업로드",
                len(state["pages"][0]["attachments"]) == 3,
                str(state["pages"][0]["attachments"]),
            )
            page_url = page.locator("[data-testid=publish-page-url]").inner_text()
            check("원격 페이지 URL 표시", "/wiki/spaces/SPEC/pages/" in page_url, page_url)

            page.locator("[data-testid=publish-tab-history]").click()
            page.wait_for_selector("[data-testid=publish-history] table tbody tr", timeout=5000)
            history_rows = page.locator("[data-testid=publish-history] tbody tr").count()
            check("발행 이력 표시", history_rows == 1, str(history_rows))
            page.screenshot(path=str(OUT_DIR / "spec-studio-w3-preview.png"))

            # ── 4. same spec again ────────────────────────────────────────
            page.locator("[data-testid=publish-run]").click()
            page.wait_for_selector(
                "[data-testid=publish-result-status]:has-text('중복 발행하지 않았습니다')", timeout=45000
            )
            state = mock_state()
            check("동일 스펙 재발행 시 페이지 0건 추가", state["pageCreates"] == 1, str(state["pageCreates"]))
            check("첨부도 3종 그대로", len(state["pages"][0]["attachments"]) == 3)

            state = sqlite_state()
            check("publish_record 1건", len(state["publishes"]) == 1, str(state["publishes"]))
            check("publish_record 상태 ok", state["publishes"][0][0] == "ok")

            check("콘솔 오류 0건", console_errors == [], " | ".join(console_errors[:3]))
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
    print("\nPASS: W3 end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
