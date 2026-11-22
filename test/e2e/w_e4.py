#!/usr/bin/env python3
"""End-to-end check for E4 — run_e4.sh drives one real daemon, one SQLite
file, the built app on `vite preview`, the mock model server, and Playwright.

F1 section (implemented — 간편/전문 모드 이원화, U-3):

  1. 첫 세션 판정 — no stored project and no saved choice ⇒ easy mode; the
     pro surfaces (인박스·그래프 탭·발행·백업·성숙도 배지·Figma 바) are hidden,
     never deleted (DG-3), and the easy set (캔버스·문서·핀·AI·출력) shows.
  2. AC-1 지향 실측 — count labelled interactive elements on the easy first
     workspace screen; must be ≤ 12 (1차 조사 baseline: 40~50).
  3. AI 제안 카드 — easy mode still reaches the whole loop: AI 설정(mock LLM)
     → 문서 문단 제안 → 결정 카드 → 채택, while the graph-only proposal stays
     pro (its card lives in the hidden graph view).
  4. DG-2 + AC-4 — a easy→pro→easy roundtrip writes zero op_log rows and the
     exported bundle's project payload hashes identically.
  5. 기존 사용자 판정 — a stored project with no saved choice resolves pro.

Extension points for the later waves (spec §5-B-4): the F4 tour/next-task
card section and the F6 덩어리 임포트 section plug in below — see
check_f4() and check_f6() stubs.

Environment (set by run_e4.sh): SPEC_STUDIO_DB, DAEMON_PORT, WEB_URL,
MOCK_LLM_URL, OUT_DIR, DAEMON_LOG — same contract as w_e1.py / w_e2.py.
"""

from __future__ import annotations

import hashlib
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
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/e2e-e4/daemon.log"))
API_KEY = "sk-e2e-secret-e4"
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


def op_log_count() -> int:
    return int(query("SELECT COUNT(*) FROM op_log")[0][0])


def project_hash(path: Path) -> str:
    """Hash the project payload only — `exportedAt` differs by construction;
    AC-4 asks whether the project survived the mode roundtrip, not the clock."""
    bundle = json.loads(path.read_text())
    return hashlib.sha256(
        json.dumps(bundle["project"], sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


# The 1차 조사 counting scope, declared here so the gate's 채점표 can pin the
# same rule: every visible native interactive element (a labelled control a
# person can press, type into, or toggle) on the first workspace screen.
INTERACTIVE_JS = """() => {
  const sel = [
    'button', 'input', 'select', 'textarea',
    'a[href]', '[role="tab"]', '[contenteditable="true"]', 'summary',
  ].join(',');
  return [...document.querySelectorAll(sel)].filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !el.hidden;
  }).length;
}"""


def export_bundle(page) -> Path:
    with page.expect_download(timeout=15000) as download_info:
        page.locator("[data-testid=export-project]").click()
    download = download_info.value
    target = OUT_DIR / download.suggested_filename
    download.save_as(target)
    return target


def check_f4() -> None:
    """Extension point (spec §5-B-4): F4 온보딩 — '다음 할 일' 카드 정합(AC-5),
    5분 투어, 용어 grep(AC-3). Implemented in the F4 wave, not F1."""


def check_f6() -> None:
    """Extension point (spec §5-B-4): F6 덩어리 임포트 — 붙여넣기→분해→채택,
    원문 해시(AC-8), 조작 ≤3회(AC-7). Implemented in the F6 wave, not F1."""


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
            context = browser.new_context(viewport={"width": 1600, "height": 950})
            page = context.new_page()
            console_errors: list[str] = []
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            # ── F1-1 첫 세션: 신규 사용자 판정 → 간편 모드 ──────────────
            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check("F1-1a 신규 첫 세션은 간편 모드", mode == "easy", str(mode))

            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)

            # DG-3: pro surfaces hidden — the elements leave the DOM entirely,
            # the features do not (data itself is untouched, pro brings them back).
            for testid in (
                "view-graph",          # 그래프 · RTM 탭
                "open-publish",        # Confluence 발행
                "backup-project",      # SQLite 백업
                "maturity-badge",      # DG-1 — 원본 체크리스트는 전문 표현
                "idea-inbox",          # 인박스
                "figma-bar",           # Figma 첨부 바
            ):
                check(
                    f"F1-1b 간편 모드 숨김: {testid}",
                    page.locator(f"[data-testid={testid}]").count() == 0,
                )
            for surface in ("topBar", "canvas", "docPanel", "pinPanel"):
                check(
                    f"F1-1c 간편 모드 노출: {surface}",
                    page.locator(f"[data-surface={surface}]").count() == 1,
                )

            # ── F1-2 AC-1 지향 실측: 간편 첫 화면 상호작용 요소 ─────────
            interactive = page.evaluate(INTERACTIVE_JS)
            print(f"     AC-1 실측: 간편 첫 화면 상호작용 요소 {interactive}개 (기준 ≤12)")
            check("AC-1 간편 첫 화면 상호작용 ≤12", interactive <= 12, str(interactive))

            # ── F1-3 AI 제안 카드 채택 (간편 모드) ──────────────────────
            # A doc first: the doc proposal patches an existing block.
            page.locator("[data-testid=doc-create]").click()
            page.locator("[data-testid=doc-create-title]").fill("F1 스펙")
            page.locator("[data-testid=doc-create-kind]").select_option("spec")
            page.locator("[data-testid=doc-create-confirm]").click()
            page.wait_for_selector("[data-testid=doc-add]", timeout=5000)
            page.locator("[data-testid=doc-add]").click()
            page.wait_for_selector("[data-testid=doc-text-1]", timeout=5000)
            page.locator("[data-testid=doc-text-1]").fill("주문 상세 화면의 취소 정책을 정리한다.")

            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            check(
                "F1-3a 간편 모드는 그래프 제안 버튼을 숨긴다(카드가 pro 서피스에 귀속)",
                page.locator("[data-testid=ai-extract-graph]").count() == 0,
            )
            page.locator("[data-testid=ai-provider]").select_option("openai")
            page.locator("[data-testid=ai-model]").fill(MODEL)
            page.locator("[data-testid=ai-endpoint]").fill(f"{MOCK_LLM_URL}/v1")
            page.locator("[data-testid=ai-key]").fill(API_KEY)
            page.locator("[data-testid=ai-test]").click()
            page.wait_for_selector("[data-testid=ai-status][data-state=ok]", timeout=20000)
            page.locator("[data-testid=ai-extract-doc]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            check(
                "F1-3b 간편 모드 LLM 제안 카드 도착",
                page.locator("[data-testid=proposal-source]").get_attribute("data-source")
                == "llm",
            )
            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_timeout(800)
            adopted = page.locator("[data-testid=doc-text-1]").input_value()
            check(
                "F1-3c 채택이 문단에 반영",
                "핀과 맞춥니다" not in adopted and "주문 상세" in adopted,
                adopted[:80],
            )
            check(
                "F1-3d 채택은 op_log에 기록(쓰기 경로 준수)",
                op_log_count() > 0,
                str(op_log_count()),
            )

            # ── F1-4 DG-2 + AC-4: 왕복 무손실 ───────────────────────────
            ops_before = op_log_count()
            first_bundle = export_bundle(page)
            hash_before = project_hash(first_bundle)

            page.locator("[data-testid=mode-switch]").click()
            page.wait_for_timeout(400)
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check("F1-4a 원클릭 전환 → 전문", mode == "pro", str(mode))
            for testid in ("view-graph", "open-publish", "backup-project", "maturity-badge", "idea-inbox", "figma-bar"):
                check(
                    f"F1-4b 전문 모드 복원: {testid}",
                    page.locator(f"[data-testid={testid}]").count() >= 1,
                )

            page.locator("[data-testid=mode-switch]").click()
            page.wait_for_timeout(400)
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check("F1-4c 원클릭 왕복 → 간편", mode == "easy", str(mode))
            check(
                "F1-4d 왕복 후 인박스 재은닉",
                page.locator("[data-testid=idea-inbox]").count() == 0,
            )

            ops_after = op_log_count()
            check(
                "DG-2 모드 전환 커맨드/op_log 0건",
                ops_after == ops_before,
                f"{ops_before} → {ops_after}",
            )

            second_bundle = export_bundle(page)
            hash_after = project_hash(second_bundle)
            check(
                "AC-4 왕복 후 번들 프로젝트 해시 동일",
                hash_after == hash_before,
                f"{hash_before[:12]} → {hash_after[:12]}",
            )

            # ── F1-5 기존 사용자 판정: 저장 프로젝트 + 미선택 → 전문 ────
            project_payload = json.loads(first_bundle.read_text())["project"]
            page.evaluate(
                """(project) => {
                    window.localStorage.removeItem('spec-studio.settings.v1');
                    window.localStorage.setItem('spec-studio.project.v1', JSON.stringify(project));
                }""",
                project_payload,
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check(
                "F1-5a 기존 로컬 데이터 보유 사용자 → 전문 모드",
                mode == "pro",
                str(mode),
            )
            check(
                "F1-5b 전문 모드에서 인박스 노출",
                page.locator("[data-testid=idea-inbox]").count() == 1,
            )
            # …and the remembered choice survives another reload (선택 기억).
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check("F1-5c 판정된 모드가 재기동 후에도 기억", mode == "pro", str(mode))

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
    print("\nPASS: E4 F1 — 간편 첫 세션 · AI 제안 채택 · 모드 왕복 무손실(AC-4) · 커맨드 0건(DG-2)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
