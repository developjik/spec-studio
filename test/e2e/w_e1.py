#!/usr/bin/env python3
"""End-to-end check for the E1 spine: capture → brief → promote → graph
proposal → F4 handoff package → idempotent re-export.

A real daemon, a real SQLite file, a real built app served by `vite preview`,
and a mock model server. The browser walks the whole promise:

  1. 아이디어 캡처 (quick add) — the inbox row is the package's first reader
  2. 리서치 문서 + 근거 클립 — the brief's grounding
  3. 그래프 제안 채택 — requirement nodes for tasks.md
  4. 리서치 브리브 → LLM 카드 → 채택 — sourced paragraphs in the spec doc
  5. 스펙으로 승격 — promoted idea + spec tab
  6. 전달 패키지 내보내기 — one click → one zip with six files (AC-8)
  7. 재내보내기 — confirmation, then the same six files byte-for-byte
  8. op_log/event — two `package.export` rows, F6 device_id stamped (AC-7)

Environment (set by the runner):
  SPEC_STUDIO_DB   the SQLite file the daemon owns
  DAEMON_PORT      the daemon's port (dynamic — 8799 is taken on this host)
  WEB_URL          default http://127.0.0.1:5173
  MOCK_LLM_URL     the mock model server
  OUT_DIR          where the zips + manifest land (default: downloads)
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zipfile
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
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/e1e2e/daemon.log"))
API_KEY = "sk-e2e-secret-e1"
MODEL = "mock-1"

EXPECTED_ENTRIES = {
    "spec-summary.md",
    "spec-studio-scr-110-overlay.png",
    "spec-studio-scr-110.html",
    "spec-studio-scr-110-qa.csv",
    "tasks.md",
    "bundle.json",
}

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


def read_zip(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


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

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )

            # ── 1. 화면 + 핀 — the package's QA CSV and overlay ──────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            stage = page.locator("[data-testid=stage]").bounding_box()
            assert stage is not None
            for fx, fy, kind, title, body in [
                (0.30, 0.35, "exception", "재고 없음 안내", "재고 0이면 버튼 비활성"),
                (0.66, 0.60, "function", "취소 요청", "배송 준비 중일 때만 활성"),
            ]:
                page.mouse.click(stage["x"] + stage["width"] * fx, stage["y"] + stage["height"] * fy)
                page.locator("[data-testid=pin-title]").fill(title)
                page.locator("[data-testid=pin-body]").fill(body)
                page.locator(f"[data-testid=type-{kind}]").click()
                page.locator("[data-testid=pin-save]").click()
                page.wait_for_timeout(250)
            page.wait_for_selector("[data-testid=pin-2]", timeout=5000)

            # ── 2. AI 설정: mock endpoint ───────────────────────────────
            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-provider]").select_option("openai")
            page.locator("[data-testid=ai-model]").fill(MODEL)
            page.locator("[data-testid=ai-endpoint]").fill(f"{MOCK_LLM_URL}/v1")
            page.locator("[data-testid=ai-key]").fill(API_KEY)
            page.locator("[data-testid=ai-test]").click()
            page.wait_for_selector("[data-testid=ai-status][data-state=ok]", timeout=20000)
            check(
                "AI 설정 연결 확인",
                "연결 정상" in page.locator("[data-testid=ai-status]").inner_text(),
            )
            page.locator("[data-testid=ai-close]").click()
            page.wait_for_timeout(300)

            # ── 3. 아이디어 캡처 ────────────────────────────────────────
            page.locator("[data-testid=idea-add-text]").fill(
                "정기결제 카드 실패 재시도\n실패한 결제는 3회까지 자동 재시도한다"
            )
            page.locator("[data-testid=idea-add-submit]").click()
            page.wait_for_selector("[data-testid=idea-item]", timeout=5000)
            check("인박스 캡처", page.locator("[data-testid=idea-item]").count() == 1)

            # ── 4. 리서치 문서 + 근거 클립 ──────────────────────────────
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
            check("근거 클립", page.locator("[data-testid=evidence-item]").count() == 1)

            # ── 5. 그래프 제안 채택 → 요구사항 노드 ─────────────────────
            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-extract-graph]").click()
            page.wait_for_selector("[data-testid=graph-proposal-card]", timeout=30000)
            page.locator("[data-testid=graph-proposal-adopt]").click()
            page.wait_for_selector("[data-testid=graph-proposal-revert]", timeout=10000)
            req_count = query(
                "SELECT COUNT(*) FROM obj WHERE kind='specnode' AND subtype='requirement' "
                "AND deleted_at IS NULL"
            )[0][0]
            check("그래프 채택 → 요구사항 노드", req_count >= 1, str(req_count))

            # adopting flips the app into the graph view — the inbox only
            # lives on the studio rail, so step back first
            page.locator("[data-testid=view-studio]").click()
            page.wait_for_selector("[data-testid=idea-item]", timeout=5000)

            # ── 6. 리서치 브리프 → 채택 ─────────────────────────────────
            page.locator("[data-testid=idea-item]").first.locator(
                "[data-testid=idea-research]"
            ).click()
            page.wait_for_selector("[data-testid=brief-picker]", timeout=5000)
            page.locator("[data-testid=idea-brief]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_timeout(1200)
            check(
                "브리프 채택 → 문단",
                query("SELECT COUNT(*) FROM block WHERE state='live'")[0][0] >= 1,
            )

            # ── 7. 스펙으로 승격 ─────────────────────────────────────────
            spec_tabs_before = page.locator("[data-testid=doc-tab][data-kind=spec]").count()
            page.locator("[data-testid=idea-item]").first.locator(
                "[data-testid=idea-promote]"
            ).click()
            page.wait_for_timeout(1000)
            check(
                "승격 → 새 스펙 탭",
                page.locator("[data-testid=doc-tab][data-kind=spec]").count()
                == spec_tabs_before + 1,
            )

            # ── 8. 전달 패키지 — one click → one zip of six files ───────
            page.locator("[data-testid=view-studio]").click()
            page.locator("[data-testid=open-outputs]").click()
            page.wait_for_selector("[data-testid=output-modal]", timeout=5000)

            zip_one = OUT_DIR / "handoff-first.zip"
            with page.expect_download(timeout=30000) as download_wait:
                page.locator("[data-testid=package-export]").click()
            download_wait.value.save_as(str(zip_one))
            check("첫 패키지 다운로드", zip_one.exists() and zip_one.stat().st_size > 0)

            entries_one = read_zip(zip_one) if zip_one.exists() else {}
            check(
                "6산출물 목록",
                set(entries_one.keys()) == EXPECTED_ENTRIES,
                str(sorted(entries_one.keys())),
            )
            summary = entries_one.get("spec-summary.md", b"").decode("utf-8", "replace")
            tasks = entries_one.get("tasks.md", b"").decode("utf-8", "replace")
            html = entries_one.get("spec-studio-scr-110.html", b"").decode("utf-8", "replace")
            csv = entries_one.get("spec-studio-scr-110-qa.csv", b"")
            png = entries_one.get("spec-studio-scr-110-overlay.png", b"")
            bundle_raw = entries_one.get("bundle.json", b"")
            check("요약 MD 내용", "# 스펙 요약" in summary and "SCR-110" in summary)
            check("tasks.md 체크박스", "- [ ] T001" in tasks, tasks[:200])
            check("HTML 자급자족", "화면설계서" in html and 'src="http' not in html)
            check("QA CSV BOM+행", csv.startswith(b"\xef\xbb\xbf") and b"TC-001" in csv)
            check("오버레이 PNG 시그니처", png.startswith(b"\x89PNG"))
            try:
                bundle = json.loads(bundle_raw)
                bundle_ok = (
                    bundle.get("format") == "spec-studio.bundle"
                    and len(bundle.get("project", {}).get("pins", [])) >= 1
                )
            except Exception:
                bundle_ok = False
            check("bundle.json 구조", bundle_ok)

            # ── 9. 재내보내기 — 확인 후 같은 바이트 ─────────────────────
            page.locator("[data-testid=package-export]").click()
            page.wait_for_selector("[data-testid=package-confirm]", timeout=5000)
            check("재내보내기 확인 다이얼로그", True)
            zip_two = OUT_DIR / "handoff-second.zip"
            with page.expect_download(timeout=30000) as download_wait:
                page.locator("[data-testid=package-confirm-submit]").click()
            download_wait.value.save_as(str(zip_two))
            entries_two = read_zip(zip_two) if zip_two.exists() else {}
            check(
                "재내보내기 6산출물 동일",
                set(entries_two.keys()) == EXPECTED_ENTRIES,
                str(sorted(entries_two.keys())),
            )
            identical = all(entries_one.get(name) == entries_two.get(name) for name in EXPECTED_ENTRIES)
            check(
                "재내보내기 바이트 멱등",
                identical,
                str(
                    [
                        name
                        for name in sorted(EXPECTED_ENTRIES)
                        if entries_one.get(name) != entries_two.get(name)
                    ]
                ),
            )

            # ── 10. 원장 — 두 번의 export, 모두 F6 스탬프 ───────────────
            op_rows = query(
                "SELECT payload, device_id FROM op_log WHERE kind='package.export' ORDER BY seq"
            )
            check("op_log package.export 2행", len(op_rows) == 2, str(op_rows))
            check(
                "op_log 파일 목록 기록",
                len(op_rows) > 0
                and set(json.loads(op_rows[0][0]).get("files", [])) == EXPECTED_ENTRIES,
            )
            check(
                "op_log device_id 스탬프",
                len(op_rows) > 0 and all(row[1] for row in op_rows),
            )
            event_rows = query(
                "SELECT device_id FROM event WHERE type='package.exported'"
            )
            check("package.exported 이벤트 2건", len(event_rows) == 2, str(event_rows))
            check(
                "이벤트 device_id 스탬프",
                len(event_rows) > 0 and all(row[0] for row in event_rows),
            )
            dupes = query(
                "SELECT device_id, seq, COUNT(*) FROM event "
                "GROUP BY device_id, seq HAVING COUNT(*) > 1"
            )
            check("(device_id, seq) 유일", dupes == [], str(dupes))

            # ── 11. artifact manifest for the verifier ──────────────────
            manifest = {
                "zip": "handoff-first.zip / handoff-second.zip",
                "entries": sorted(entries_one.keys()),
                "bytes": {name: len(data) for name, data in entries_one.items()},
                "identical_reexport": identical,
            }
            (OUT_DIR / "e1-manifest.json").write_text(json.dumps(manifest, indent=2))
            print(f"artifacts: {OUT_DIR}")
            print(f"daemon log: {DAEMON_LOG}")

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
    print("\nPASS: E1 척추 — 캡처→브리프→승격→그래프→패키지→재내보내기")
    return 0


if __name__ == "__main__":
    sys.exit(main())
