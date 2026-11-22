#!/usr/bin/env python3
"""End-to-end check for the F2 idea inbox + F3 research board (v1 W4).

A real daemon, a real SQLite file, a real built app served by `vite preview`,
and a mock model server. The browser is driven through the whole promise:

  1. 아이디어 인박스 빠른 추가 → 태그·상태 배지가 붙은 항목
  2. 리서치 문서 생성 → 근거 패널에 클립 2건
  3. 그래프 제안 채택으로 요구사항 노드 → 스펙 문서에 미근거 경고
  4. 근거로 연결 → references 링크 + 근거 상태 cited
  5. 리서치 브리프 → LLM 카드 → 채택 → 출처/근거 없음 마커가 박힌 문단
  6. 스펙으로 승격 → 새 스펙 탭 + 아이디어 상태 promoted
  7. 세션 리로드(키 소멸) 후 같은 브리프 → 로컬 규칙 카드 (AC-3)

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

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("SPEC_STUDIO_NODE", "node")
DB = os.environ["SPEC_STUDIO_DB"]
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
MOCK_LLM_URL = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:8799")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/f2f3e2e/daemon.log"))
API_KEY = "sk-e2e-secret-7f3a"
MODEL = "mock-1"

OUT_DIR.mkdir(parents=True, exist_ok=True)


def start_daemon() -> subprocess.Popen:
    env = os.environ.copy()
    env["SPEC_STUDIO_PORT"] = "8787"
    env["SPEC_STUDIO_DB"] = DB
    # No keys in the environment: the browser supplies one, which is the path
    # that must not persist — and whose absence after reload is AC-3's fallback.
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
            with urllib.request.urlopen("http://127.0.0.1:8787/api/health", timeout=0.5):
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

            # E4 F1: this suite exercises pro surfaces (인박스·근거 패널 등). A
            # fresh profile boots easy, so declare the pro choice the way the
            # mode switch persists it — the local settings key, pre-boot.
            page.add_init_script(
                "localStorage.setItem('spec-studio.settings.v1', JSON.stringify({mode:'pro'}))"
            )
            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )

            # ── 1. a screen with pins the graph can ground on ───────────
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

            # ── 2. AI 설정: mock endpoint, model, key ────────────────────
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

            # ── 3. 인박스 빠른 추가 ────────────────────────────────────────
            page.locator("[data-testid=idea-add-text]").fill(
                "정기결제 카드 실패 재시도\n실패한 결제는 3회까지 자동 재시도한다"
            )
            page.locator("[data-testid=idea-add-url]").fill("https://billing.example.com/retry")
            page.locator("[data-testid=idea-add-submit]").click()
            page.wait_for_selector("[data-testid=idea-item]", timeout=5000)
            idea_one = page.locator("[data-testid=idea-item]").first
            check(
                "인박스 항목 + 제목",
                "정기결제 카드 실패 재시도" in idea_one.inner_text(),
                idea_one.inner_text(),
            )
            check(
                "링크 태그 배지",
                idea_one.locator(".inbox-tag", has_text="링크").count() == 1,
            )

            # second idea — the one 승격 will take
            page.locator("[data-testid=idea-add-text]").fill("결제 실패 알림 템플릿")
            page.locator("[data-testid=idea-add-submit]").click()
            page.wait_for_timeout(400)
            check("인박스 2건", page.locator("[data-testid=idea-item]").count() == 2)

            # ── 4. 리서치 문서 + 근거 클립 ────────────────────────────────
            page.locator("[data-testid=doc-create]").click()
            page.locator("[data-testid=doc-create-title]").fill("결제 리서치")
            page.locator("[data-testid=doc-create-kind]").select_option("research")
            page.locator("[data-testid=doc-create-confirm]").click()
            page.wait_for_selector("[data-testid=evidence-panel]", timeout=5000)
            check(
                "리서치 탭 활성",
                page.locator("[data-testid=doc-tab][data-kind=research]").count() == 1,
            )

            for url, title, excerpt in [
                (
                    "https://billing.example.com/retry-report",
                    "재시도 성공률 보고",
                    "재시도 3회까지 누적 회수율 71%.",
                ),
                (
                    "https://ux.example.com/dunning",
                    "더닝 메일 문구 사례",
                    "실패 고지는 행동 한 가지만 요구할 때 회복률이 높았다.",
                ),
            ]:
                page.locator("[data-testid=evidence-add-url]").fill(url)
                page.locator("[data-testid=evidence-add-title]").fill(title)
                page.locator("[data-testid=evidence-add-excerpt]").fill(excerpt)
                page.locator("[data-testid=evidence-add-submit]").click()
                page.wait_for_timeout(300)
            check("근거 클립 2건", page.locator("[data-testid=evidence-item]").count() == 2)
            check(
                "근거 obj 행 2건",
                len(query("SELECT id FROM obj WHERE kind='evidence' AND deleted_at IS NULL")) == 2,
            )

            # ── 5. 그래프 제안 채택 → 요구사항 노드 ────────────────────────
            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            page.locator("[data-testid=ai-extract-graph]").click()
            page.wait_for_selector("[data-testid=graph-proposal-card]", timeout=30000)
            page.locator("[data-testid=graph-proposal-adopt]").click()
            page.wait_for_selector("[data-testid=graph-proposal-revert]", timeout=10000)
            req_ids = [
                row[0]
                for row in query(
                    "SELECT id FROM obj WHERE kind='specnode' AND subtype='requirement' "
                    "AND deleted_at IS NULL ORDER BY rowid"
                )
            ]
            check("채택 → 요구사항 노드", len(req_ids) >= 2, str(req_ids))

            # ── 6. 스펙 문서의 미근거 경고 ────────────────────────────────
            page.locator("[data-testid=view-studio]").click()
            page.locator("[data-testid=doc-tab][data-kind=spec]").first.click()
            page.wait_for_selector("[data-testid=req-ungrounded]", timeout=5000)
            ungrounded_text = page.locator("[data-testid=req-ungrounded]").inner_text()
            check(
                "미근거 요구사항 경고",
                "근거 없는 요구사항" in ungrounded_text,
                ungrounded_text,
            )

            # ── 7. 근거로 연결 → references 링크 ─────────────────────────
            page.locator("[data-testid=doc-tab][data-kind=research]").click()
            page.wait_for_selector("[data-testid=evidence-panel]", timeout=5000)
            first_evidence = page.locator("[data-testid=evidence-item]").first
            first_evidence.locator("[data-testid=evidence-link-target]").select_option(index=0)
            first_evidence.locator("[data-testid=evidence-link]").click()
            page.wait_for_timeout(800)
            # `link` has no tombstone — a missing row is a missing link.
            ref_links = query("SELECT src, dst FROM link WHERE type='references'")
            check("references 링크 행", len(ref_links) >= 1, str(ref_links))
            check(
                "근거 상태 cited",
                query(
                    "SELECT COUNT(*) FROM obj WHERE kind='evidence' AND state='cited'"
                )[0][0]
                >= 1,
            )

            # ── 8. 리서치 브리프 → LLM 카드 → 채택 ────────────────────────
            idea_one = page.locator("[data-testid=idea-item]").first
            idea_one.locator("[data-testid=idea-research]").click()
            page.wait_for_selector("[data-testid=brief-picker]", timeout=5000)
            # One clip is 'cited' by the link above — the picker offers the
            # captured remainder only.
            check(
                "브리프 근거 선택지",
                page.locator("[data-testid=brief-evidence]").count() == 1,
            )
            page.locator("[data-testid=idea-brief]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            source = page.locator("[data-testid=proposal-source]")
            check(
                "브리프 카드 LLM 배지",
                source.get_attribute("data-source") == "llm",
                str(source.get_attribute("data-source")),
            )
            page.locator("[data-testid=proposal-adopt]").click()
            page.wait_for_timeout(1200)
            block_texts = "\n".join(
                row[0] for row in query("SELECT text FROM block WHERE state='live' ORDER BY rowid")
            )
            check("채택 문단 출처 표시", "(출처:" in block_texts, block_texts[:200])
            check("채택 문단 근거 없음 표시", "(근거 없음)" in block_texts, block_texts[:200])
            shot = OUT_DIR / "spec-studio-w4-f2f3-brief.png"
            page.screenshot(path=str(shot))
            check("스크린샷 저장", shot.exists(), str(shot))

            # ── 9. 스펙으로 승격 ─────────────────────────────────────────
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
            check(
                "승격 아이디어 상태",
                page.locator("[data-testid=idea-item][data-state=promoted]").count() == 1,
            )

            # ── 10. AC-3: 리로드로 키가 사라지면 로컬 규칙 ────────────────
            # networkidle은 프로젝트 op SSE 스트림과 경합한다 — w_e4 패턴:
            # domcontentloaded + 데몬 연결 대기로 readiness를 잡는다.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.wait_for_selector("[data-testid=idea-item]", timeout=10000)
            captured = page.locator("[data-testid=idea-item][data-state=captured]").first
            captured.locator("[data-testid=idea-research]").click()
            page.wait_for_selector("[data-testid=brief-picker]", timeout=5000)
            page.locator("[data-testid=idea-brief]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=30000)
            fallback = page.locator("[data-testid=proposal-source]")
            check(
                "키 없는 브리프 → 로컬 규칙",
                fallback.get_attribute("data-source") == "rule"
                and "AI 없음" in fallback.inner_text()
                and "규칙 기반" in fallback.inner_text(),
                f"{fallback.get_attribute('data-source')} / {fallback.inner_text()}",
            )

            # ── 11. the key is nowhere on disk ─────────────────────────
            raw_db = Path(DB).read_bytes()
            check("SQLite 파일에 키 없음", API_KEY.encode() not in raw_db)
            log_text = DAEMON_LOG.read_text(errors="ignore") if DAEMON_LOG.exists() else ""
            check("데몬 로그에 키 없음", API_KEY not in log_text)

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
    print("\nPASS: F2 인박스 · F3 리서치 보드 end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
