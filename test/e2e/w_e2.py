#!/usr/bin/env python3
"""End-to-end check for E2 W0 (v16): the E1 quality-gate regressions plus the
new durable-seeding and journey-instrumentation promises.

One real daemon, one SQLite file, the built app on `vite preview`, the mock
model server — the browser walks:

  1. F-1 ×2 — a paragraph edit's blur commit must not eat the click that
     caused it: (a) click "+ 문단 추가", (b) click the "+" doc tab
  2. F-2 — the undo chip names the ledger's latest op the moment the command
     lands: create → rename → delete, each replacing the previous chip
  3. F-3 — undoing a *document* op says "문서 삭제 — 되돌렸습니다", never
     the adoption phrasing
  4. F-4 — the ✎ tab renames the active doc through `doc.update`
  5. MN-A — file a brief for an idea, restart the *daemon*, then promote:
     the new spec opens seeded from the persisted `proposal.idea_id`, not
     the raw idea text a session Map used to lose
  6. AC-1 — `journey.mark` rows for attach → capture → brief → promote,
     each `elapsedMs` ≥ 0; `journey:report` renders them

Environment (set by run_e2.sh): SPEC_STUDIO_DB, DAEMON_PORT, WEB_URL,
MOCK_LLM_URL, OUT_DIR, DAEMON_LOG — same contract as w_e1.py.
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
DAEMON_PORT = int(os.environ.get("DAEMON_PORT", "8787"))
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
MOCK_LLM_URL = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:8799")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/e2e-e2/daemon.log"))
API_KEY = "sk-e2e-secret-e2"
MODEL = "mock-1"

OUT_DIR.mkdir(parents=True, exist_ok=True)


def start_daemon() -> subprocess.Popen:
    env = os.environ.copy()
    env["SPEC_STUDIO_PORT"] = str(DAEMON_PORT)
    env["SPEC_STUDIO_DB"] = DB
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
            with urllib.request.urlopen(
                f"http://127.0.0.1:{DAEMON_PORT}/api/health", timeout=0.5
            ):
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
            page = browser.new_page(viewport={"width": 1600, "height": 950})
            console_errors: list[str] = []
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            # E4 F1: E2 exercises pro surfaces. A fresh profile boots easy, so
            # declare the pro choice the way the mode switch persists it —
            # the local settings key, written before the app boots.
            page.add_init_script(
                "localStorage.setItem('spec-studio.settings.v1', JSON.stringify({mode:'pro'}))"
            )
            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )

            # ── 0. 화면 + AI 설정 — the attach mark and the brief's backend ─
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)

            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-provider]").select_option("openai")
            page.locator("[data-testid=ai-model]").fill(MODEL)
            page.locator("[data-testid=ai-endpoint]").fill(f"{MOCK_LLM_URL}/v1")
            page.locator("[data-testid=ai-key]").fill(API_KEY)
            page.locator("[data-testid=ai-test]").click()
            page.wait_for_selector("[data-testid=ai-status][data-state=ok]", timeout=20000)
            page.locator("[data-testid=ai-close]").click()
            page.wait_for_timeout(300)

            # ── 1. F-1 (a): edit → "+ 문단 추가" must land ───────────────
            # The blur's commit used to flip busy before this click landed,
            # so the first interaction after editing was swallowed whole.
            page.locator("[data-testid=doc-add]").click()
            page.wait_for_selector("[data-testid=doc-text-1]", timeout=5000)
            page.locator("[data-testid=doc-text-1]").fill("편집 직후 첫 상호작용 회귀")
            page.locator("[data-testid=doc-add]").click()
            landed = page.wait_for_selector("[data-testid=doc-text-2]", timeout=5000)
            check("F-1a 편집 직후 '+ 문단 추가' 클릭", landed is not None)

            # ── 2. F-1 (b): edit → "+" doc tab must land ─────────────────
            page.locator("[data-testid=doc-text-2]").fill("두 번째 상호작용 회귀")
            page.locator("[data-testid=doc-create]").click()
            create_form = page.wait_for_selector("[data-testid=doc-create-title]", timeout=5000)
            check("F-1b 편집 직후 '+ 문서' 탭 클릭", create_form is not None)

            # ── 3. F-2: create → chip names doc.create immediately ───────
            page.locator("[data-testid=doc-create-title]").fill("E2 신규 문서")
            page.locator("[data-testid=doc-create-kind]").select_option("spec")
            page.locator("[data-testid=doc-create-confirm]").click()
            page.wait_for_selector("[data-testid=doc-undo]", timeout=5000)
            chip = page.locator("[data-testid=doc-undo]").inner_text()
            check("F-2 생성 직후 언두 칩", "문서 생성" in chip, chip)

            # ── 4. F-4: ✎ renames the active doc through doc.update ──────
            page.locator("[data-testid=doc-rename]").click()
            page.wait_for_selector("[data-testid=doc-rename-input]", timeout=5000)
            page.locator("[data-testid=doc-rename-input]").fill("이름 바꾼 E2 문서")
            page.locator("[data-testid=doc-rename-confirm]").click()
            page.wait_for_timeout(600)
            active_tab = page.locator("[data-testid=doc-tab][aria-selected=true]").inner_text()
            check("F-4 문서 이름 변경", "이름 바꾼 E2 문서" in active_tab, active_tab)
            chip = page.locator("[data-testid=doc-undo]").inner_text()
            check("F-2 이름변경 후 칩 갱신", "이름 변경" in chip, chip)
            named = query("SELECT title FROM doc WHERE title='이름 바꾼 E2 문서'")
            check("F-4 이름 변경 원장 기록", len(named) == 1, str(named))

            # ── 5. F-2: delete → the stale create chip is replaced ────────
            page.locator("[data-testid=doc-delete]").click()
            page.locator("[data-testid=doc-delete]").click()  # armed → confirm
            page.wait_for_timeout(600)
            chip = page.locator("[data-testid=doc-undo]").inner_text()
            check("F-2 삭제 후 칩이 삭제로 교체", "문서 삭제" in chip, chip)

            # ── 6. F-3: undoing a doc op speaks doc, not adoption ────────
            page.locator("[data-testid=doc-undo]").click()
            toast = page.locator(".toast").last
            page.wait_for_timeout(600)
            toast_text = toast.inner_text()
            check(
                "F-3 문서 되돌리기 메시지",
                "문서 삭제" in toast_text
                and "되돌렸습니다" in toast_text
                and "채택" not in toast_text,
                toast_text,
            )

            # ── 7. 아이디어 캡처 → 리서치 → 브리프 (MN-A의 씨앗) ─────────
            idea_text = "정기결제 카드 실패 재시도 아이디어 본문"
            page.locator("[data-testid=idea-add-text]").fill(idea_text)
            page.locator("[data-testid=idea-add-submit]").click()
            page.wait_for_selector("[data-testid=idea-item]", timeout=5000)

            page.locator("[data-testid=doc-create]").click()
            page.locator("[data-testid=doc-create-title]").fill("결제 리서치")
            page.locator("[data-testid=doc-create-kind]").select_option("research")
            page.locator("[data-testid=doc-create-confirm]").click()
            page.wait_for_selector("[data-testid=evidence-panel]", timeout=5000)
            page.locator("[data-testid=evidence-add-url]").fill(
                "https://billing.example.com/retry-report"
            )
            page.locator("[data-testid=evidence-add-title]").fill("재시도 성공률 보고")
            page.locator("[data-testid=evidence-add-excerpt]").fill(
                "재시도 3회까지 누적 회수율 71%."
            )
            page.locator("[data-testid=evidence-add-submit]").click()
            page.wait_for_timeout(400)

            page.locator("[data-testid=idea-item]").first.locator(
                "[data-testid=idea-research]"
            ).click()
            page.wait_for_selector("[data-testid=brief-picker]", timeout=5000)
            page.locator("[data-testid=idea-brief]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            card_summary = page.locator("[data-testid=proposal-summary]").inner_text()
            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_timeout(800)
            carried = query(
                "SELECT idea_id FROM proposal WHERE idea_id IS NOT NULL"
            )
            check("브리프 제안이 idea_id를 영속", len(carried) == 1, str(carried))

            # ── 8. MN-A: daemon restart, then promote — the seed survived ─
            # A fresh page after the restart: the old tab can hold sockets to
            # the daemon that just died, which is not what is being tested.
            # It must close *before* terminate — its open SSE op stream keeps
            # server.close() waiting on the socket past the 15s grace.
            page.close()
            daemon.terminate()
            daemon.wait(timeout=15)
            daemon = start_daemon()
            page = browser.new_page(viewport={"width": 1600, "height": 950})
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))
            page.add_init_script(
                "localStorage.setItem('spec-studio.settings.v1', JSON.stringify({mode:'pro'}))"
            )
            page.goto(WEB_URL, wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.wait_for_selector("[data-testid=idea-item]", timeout=10000)

            spec_tabs_before = page.locator("[data-testid=doc-tab][data-kind=spec]").count()
            page.locator("[data-testid=idea-item]").first.locator(
                "[data-testid=idea-promote]"
            ).click()
            page.wait_for_timeout(1200)
            promoted_tabs = page.locator("[data-testid=doc-tab][data-kind=spec]").count()
            check("MN-A 재시작 후 승격 → 스펙 탭", promoted_tabs == spec_tabs_before + 1,
                  f"{spec_tabs_before} → {promoted_tabs}")
            seed_text = page.locator("[data-testid=doc-text-1]").input_value()
            check(
                "MN-A 시드가 브리프 요약 (아이디어 원문 아님)",
                "리서치 브리프 초안" in seed_text and seed_text != idea_text,
                seed_text[:120],
            )

            # ── 9. AC-1: journey marks + the report ──────────────────────
            marks = query(
                "SELECT payload, at FROM event WHERE type='journey.mark' ORDER BY seq"
            )
            stages = [json.loads(payload).get("stage") for payload, _ in marks]
            elapsed = [json.loads(payload).get("elapsedMs") for payload, _ in marks]
            check(
                "journey.mark 마일스톤",
                stages == ["attach", "capture", "brief", "promote"],
                str(stages),
            )
            check(
                "journey.mark elapsedMs ≥ 0",
                all(isinstance(ms, (int, float)) and ms >= 0 for ms in elapsed),
                str(elapsed),
            )
            report = subprocess.run(
                [NODE, "scripts/journey-report.mjs", DB],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=30,
            )
            check(
                "journey:report 출력",
                report.returncode == 0
                and "화면 등록" in report.stdout
                and "스펙 승격" in report.stdout,
                report.stdout[:200] + report.stderr[:200],
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
    print("\nPASS: E2 W0 — F-1×2 · F-2 · F-3 · F-4 · MN-A 재시작 시딩 · journey.mark")
    return 0


if __name__ == "__main__":
    sys.exit(main())
