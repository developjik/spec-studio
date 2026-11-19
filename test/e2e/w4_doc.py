#!/usr/bin/env python3
"""End-to-end check for W4 (document ↔ pin, one decision card, revert).

Runs a real daemon, a real SQLite file and Vite, then drives the browser at
1440×900:

  1. sample screen + pins → a paragraph is added and linked to a pin
  2. the paragraph's chip selects the pin, and the pin panel jumps back
  3. a pin edit marks the paragraph stale
  4. one proposal → one decision card → adopt changes the text → revert restores
     the block from `op_log.before`
  5. a reload and a daemon restart keep the document, the proposal and op_log

Environment (set by the runner):
  SPEC_STUDIO_DB   the SQLite file the daemon owns
  WEB_URL          default http://127.0.0.1:5173
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
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/w4e2e/daemon.log"))

OUT_DIR.mkdir(parents=True, exist_ok=True)

PROSE = "배송이 시작되기 전까지만 취소할 수 있다."
NEW_TITLE = "취소 요청 버튼"


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
    for _ in range(100):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8787/api/health", timeout=0.5):
                return process
        except Exception:
            time.sleep(0.1)
    raise SystemExit("daemon did not become healthy")


def sqlite_state() -> dict:
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        doc = connection.execute(
            "SELECT id, project_id, screen_id, rev FROM doc ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        blocks = connection.execute(
            "SELECT id, idx, text, attrs, state FROM block WHERE state = 'live' ORDER BY idx"
        ).fetchall()
        proposal = connection.execute(
            "SELECT id, state, summary FROM proposal ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        ops = connection.execute(
            "SELECT seq, kind, target, before FROM op_log ORDER BY seq"
        ).fetchall()
        return {"doc": doc, "blocks": blocks, "proposal": proposal, "ops": ops}
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
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            check("SQLite 데몬에 연결됨 배지", True)

            # ── 1. sample screen + three pins ────────────────────────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            stage = page.locator("[data-testid=stage]").bounding_box()
            if stage is None:
                raise SystemExit("stage is not laid out")
            for fx, fy, kind, title, body in [
                (0.22, 0.30, "function", "취소 요청", "배송 준비 중일 때만 활성"),
                (0.56, 0.48, "policy", "배송 시작 후 취소 불가", "사전조건: 배송 시작"),
                (0.78, 0.66, "exception", "재고 없음 안내", "재고 0이면 버튼 비활성"),
            ]:
                page.mouse.click(stage["x"] + stage["width"] * fx, stage["y"] + stage["height"] * fy)
                page.locator("[data-testid=pin-title]").fill(title)
                page.locator("[data-testid=pin-body]").fill(body)
                page.locator(f"[data-testid=type-{kind}]").click()
                page.locator("[data-testid=pin-save]").click()
                page.wait_for_timeout(320)
            page.wait_for_selector("[data-testid=pin-3]", timeout=5000)
            check("번호 핀 3개 생성", page.locator("[data-testid=pin-1]").count() == 1)
            check("문서 패널이 함께 열림", page.locator("[data-testid=doc-panel]").count() == 1)

            # ── 2. a paragraph, linked to pin #1 ─────────────────────────
            page.locator("[data-testid=doc-add]").click()
            page.wait_for_selector("[data-testid=doc-block-1]", timeout=5000)
            page.locator("[data-testid=doc-text-1]").fill(PROSE)
            page.locator("[data-testid=doc-text-1]").press("Tab")
            page.wait_for_timeout(400)

            page.locator("[data-testid=link-select-1]").select_option(label="#1 취소 요청")
            page.wait_for_selector("[data-testid=chip-1-1]", timeout=5000)
            check("문단에 핀 #1 연결", page.locator("[data-testid=chip-1-1]").count() == 1)

            state = sqlite_state()
            check("SQLite에 doc 행 (project·screen 소속)", state["doc"] is not None, str(state["doc"]))
            check(
                "SQLite에 block 행 + pinRefs",
                len(state["blocks"]) == 1 and "pinRefs" in state["blocks"][0][3],
                str(state["blocks"]),
            )

            # ── 3. two-way move: chip → pin, pin → paragraph ─────────────
            page.locator("[data-testid=chip-1-1]").click()
            page.wait_for_selector("[data-testid=pin-row-1][data-selected=true]", timeout=5000)
            check("문단 칩 클릭 → 핀 #1 선택", True)

            page.locator("[data-testid=pin-row-2]").click()
            page.wait_for_selector("[data-testid=pin-row-2][data-selected=true]", timeout=5000)
            page.locator("[data-testid=chip-1-1]").click()
            page.wait_for_selector("[data-testid=pin-ref-list]", timeout=5000)
            refs = page.locator("[data-testid=pin-ref-list] li").count()
            check("핀 패널에 참조 문단 1건", refs == 1, str(refs))
            page.locator("[data-testid=pin-ref-1]").click()
            page.wait_for_timeout(300)
            focused = page.locator("[data-testid=doc-block-1]").get_attribute("class") or ""
            check("참조 문단 클릭 → 문단 포커스", "is-focused" in focused, focused)
            page.screenshot(path=str(OUT_DIR / "spec-studio-w4-linked.png"))

            # ── 4. a pin edit marks the paragraph stale ──────────────────
            page.locator("[data-testid=pin-row-1]").click()
            page.locator("[data-testid=edit-title]").fill(NEW_TITLE)
            page.locator("[data-testid=edit-save]").click()
            page.wait_for_selector("[data-testid=block-stale-1]", timeout=5000)
            check("핀 수정 → 문단 stale 배지", True)
            check(
                "stale 수가 문서 헤더에 표시",
                page.locator("[data-testid=doc-stale-count]").count() == 1,
            )

            # ── 5. one proposal, one card ────────────────────────────────
            page.locator("[data-testid=mode-proposal]").click()
            page.locator("[data-testid=proposal-create]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=5000)
            cards = page.locator("[data-testid=proposal-card]").count()
            patches = page.locator("[data-testid=proposal-patch]").count()
            summary = page.locator("[data-testid=proposal-summary]").inner_text()
            check("결정 카드 1개", cards == 1, str(cards))
            check("변경 전/후 patch 1건", patches == 1, str(patches))
            check("요약 1줄에 핀 번호", "#1" in summary, summary)
            page.wait_for_timeout(200)
            page.screenshot(path=str(OUT_DIR / "spec-studio-w4-preview.png"))

            text_before = page.locator("[data-testid=doc-text-1]").input_value()
            check("채택 전 본문은 그대로", text_before.startswith(PROSE), text_before)

            # ── 6. adopt → text changes, revert → op_log.before ──────────
            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_selector("[data-testid=adopted-bar]", timeout=8000)
            page.wait_for_timeout(5600)  # let the toast step aside for the capture
            text_adopted = page.locator("[data-testid=doc-text-1]").input_value()
            check("채택 → 문단이 새 핀 제목으로 갱신", NEW_TITLE in text_adopted, text_adopted)
            page.screenshot(path=str(OUT_DIR / "spec-studio-w4-adopted.png"))

            state = sqlite_state()
            adopt_rows = [row for row in state["ops"] if row[1] == "proposal.adopt"]
            check("op_log에 proposal.adopt 1건", len(adopt_rows) == 1, str(adopt_rows))
            before_entries = (
                json.loads(adopt_rows[0][3])["entries"] if adopt_rows else []
            )
            check(
                "op_log.before에 블록 스냅샷",
                len(before_entries) == 1 and before_entries[0]["text"].startswith(PROSE),
                str(before_entries),
            )

            page.locator("[data-testid=proposal-revert]").click()
            page.wait_for_selector("[data-testid=reverted-note]", timeout=8000)
            page.wait_for_timeout(300)
            text_reverted = page.locator("[data-testid=doc-text-1]").input_value()
            check("되돌리기 → 채택 직전 문단 복원", text_reverted == text_before, text_reverted)

            state = sqlite_state()
            revert_rows = [row for row in state["ops"] if row[1] == "proposal.revert"]
            check("op_log에 proposal.revert 1건", len(revert_rows) == 1, str(revert_rows))
            check(
                "되돌린 채택 seq를 payload에 기록",
                bool(revert_rows) and json.loads(revert_rows[0][3])["entries"][0]["text"].startswith(PROSE),
                str(revert_rows),
            )
            page.screenshot(path=str(OUT_DIR / "spec-studio-w4-reverted.png"))

            # the pin is still changed after the revert, so the block is stale
            # again — a person can accept the sentence instead of a proposal
            check(
                "되돌린 뒤 문단은 다시 stale",
                page.locator("[data-testid=block-stale-1]").count() == 1,
            )
            page.locator("[data-testid=mode-direct]").click()
            page.locator("[data-testid=stale-clear-1]").click()
            page.wait_for_timeout(500)
            check(
                "확인·해제 → stale 배지 사라짐",
                page.locator("[data-testid=block-stale-1]").count() == 0,
            )
            text_cleared = page.locator("[data-testid=doc-text-1]").input_value()
            check(
                "해제는 핀의 새 제목으로 인용을 다시 맞춤",
                NEW_TITLE in text_cleared,
                text_cleared,
            )

            # ── 7. reload, then daemon restart ──────────────────────────
            page.reload(wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.wait_for_selector("[data-testid=doc-block-1]", timeout=8000)
            persisted = page.locator("[data-testid=doc-text-1]").input_value()
            check("새로고침 후 문단 유지", persisted == text_cleared, persisted)

            daemon.terminate()
            daemon.wait(timeout=15)
            daemon = start_daemon()
            # A fresh page after the restart: the same tab can end up holding
            # sockets to the daemon that just died, which is not what is tested.
            page.close()
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("pageerror", lambda error: console_errors.append(str(error)))
            page.goto(WEB_URL, wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.wait_for_selector("[data-testid=doc-block-1]", timeout=15000)
            after_restart = page.locator("[data-testid=doc-text-1]").input_value()
            check("데몬 재기동 후 문단 유지", after_restart == text_cleared, after_restart)
            check(
                "재기동 후 되돌리기 버튼 없음 (이미 되돌림)",
                page.locator("[data-testid=proposal-revert]").count() == 0,
            )

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
    print("\nPASS: W4 end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
