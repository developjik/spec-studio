#!/usr/bin/env python3
"""End-to-end check for E4 — run_e4.sh drives one real daemon, one SQLite
file, the built app on `vite preview`, the mock model server, and Playwright.

F2 section (implemented — 챗 퍼스트 점진 재배치, U-2 · a안):

  0. EntryGate 문구 — 내부 용어(W-n·E-n·AC-n·F-n-n·R-n 패턴) 0건.
     `SCR-110-3` 같은 핀 코드(도메인 어휘)는 글자에 붙은 형태라 제외 —
     AC-3의 전수 grep 게이트는 F4 소관.
  1. 간편 첫 화면 챗 퍼스트 구성 — chatDock 서피스(입력·올리기·대화 시작)가
     작업실 위에 노출되고, 런 0건이면 챗 뼈대(runPanel)는 아직 숨는다.
  2. 챗 제출 → 커맨드만 발행(DG-2): op_log의 신규 행이 전부 기존 커맨드 종류
     (idea.capture·doc.create·run.start)이고, 그 런이 간편 모드의 챗 뼈대로
     노출된다. 리서치 문서(브리프·카드의 집)는 easy 서피스 그대로 전면 유지.
  3. needs_input 답변 뼈대 — e2e 환경은 프로바이더 키가 없어 모델이 못
     도니, needs_input 런을 스토어에 직접 심어(고정물) 질문·답변 UI와
     run.answer 커맨드 발행을 검증한다. 챗 조작 자체는 커맨드만 발행.
  4. 작업실 잔존(전문) — pro로 전환하면 chatDock은 숨고 캔버스·문서·핀·
     인박스·런 레일이 현행 그대로다. 전문 첫 화면 상호작용 계수는 참고치
     (A-F2-1 — 게이트 아님)로 출력만 한다.

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

F3 section (implemented — AI 접근 경로 정비):

  1. 키 발급 가이드 — 콘솔 딥링크(Anthropic·OpenAI)·단계·유료 안내·요금 링크,
     BYOK 우선순위 문구 승계.
  2. 로컬 런타임 감지 — /api/ai localServers와 모달 배너의 정합(미발견 침묵;
     도달 양성 케이스는 유닛 테스트의 aiFetch 모의가 담당).
  3. 폴백 정직화 — 규칙 카드의 통일 마커 'AI 없음·규칙 기반 제안' + 간편 강조
     + proposal_op.view JSON 영속(재기동 후에도 같은 배지).
  4. 구독 탭 — 'E2에서 제공 예정' 잘못 표기 제거, 준비 중 + BYOK·로컬 경로.

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
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
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


def query_write(sql: str, params: tuple = ()) -> None:
    """Fixture writes (F2-3): the daemon's SQLite file, WAL-shared."""
    connection = sqlite3.connect(DB, timeout=10)
    try:
        connection.execute(sql, params)
        connection.commit()
    finally:
        connection.close()


def op_log_count() -> int:
    return int(query("SELECT COUNT(*) FROM op_log")[0][0])


def op_log_kinds_after(seq: int) -> list[str]:
    return [row[0] for row in query("SELECT kind FROM op_log WHERE seq > ? ORDER BY seq", (seq,))]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# F2-0: 내부 용어 패턴. 도메인 코드(SCR-110-3 — 화면-핀 번호 체계)가 false
# positive 되지 않게, 글자에 바로 붙은 형태는 제외한다.
INTERNAL_TERM = re.compile(r"(?<![A-Za-z])(?:W\d+|E\d+|AC-\d+|F\d+-\d+|R-\d+)")


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

# Same rule, but names what it counted — the AC-1 재실측 evidence line in the
# report lists every element instead of just the total.
INTERACTIVE_LIST_JS = """() => {
  const sel = [
    'button', 'input', 'select', 'textarea',
    'a[href]', '[role="tab"]', '[contenteditable="true"]', 'summary',
  ].join(',');
  return [...document.querySelectorAll(sel)].filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !el.hidden;
  }).map((el) => el.dataset.testid ?? el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 24) ?? el.tagName);
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

            # ── F2-0 EntryGate 문구 — 내부 용어 제거 (F2 범위) ──────────
            gate_text = page.locator("[data-surface=entryGate]").inner_text()
            leaks = INTERNAL_TERM.findall(gate_text)
            check(
                "F2-0 EntryGate 내부 용어(W·E·AC·F-N·R-N) 0건",
                leaks == [],
                " ".join(leaks),
            )

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

            # ── F2-1 간편 첫 화면 챗 퍼스트 구성 — 입력이 전면, 작업실은 유지 ──
            check(
                "F2-1a 챗 도크 서피스 노출(올리고·대화로 시작)",
                page.locator("[data-surface=chatDock]").count() == 1,
            )
            check(
                "F2-1b 챗 입력창·전송 버튼",
                page.locator("[data-testid=chat-input]").count() == 1
                and page.locator("[data-testid=chat-submit]").count() == 1,
            )
            check(
                "F2-1c 올리기(화면 업로드) 입력 전면",
                page.locator("[data-testid=chat-upload]").count() == 1,
            )
            check(
                "F2-1d 런 0건 — 챗 뼈대(runPanel)는 대화 전까지 숨김",
                page.locator("[data-surface=runPanel]").count() == 0,
            )

            # ── F1-2 AC-1 지향 실측: 간편 첫 화면 상호작용 요소 (F2 후 재실측) ──
            interactive_items = page.evaluate(INTERACTIVE_LIST_JS)
            interactive = len(interactive_items)
            print(f"     AC-1 재실측(F2): 간편 첫 화면 상호작용 요소 {interactive}개 (기준 ≤12)")
            for item in interactive_items:
                print(f"        · {item}")
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

            # ── F2-2 챗 제출 → 커맨드만 발행(DG-2) + 챗 뼈대 노출 ────────
            ops_before_chat = op_log_count()
            page.locator("[data-testid=chat-input]").fill(
                "취소 정책을 경쟁사 기준으로 정리해줘"
            )
            page.locator("[data-testid=chat-submit]").click()
            page.wait_for_selector("[data-surface=runPanel]", timeout=15000)
            check(
                "F2-2a 챗 제출 후 간편 모드에 챗 뼈대(runPanel) 노출",
                page.locator("[data-surface=runPanel]").count() == 1,
            )
            check(
                "F2-2b 대화(런)가 도크에 잡힘",
                page.locator("[data-testid=run-state]").count() >= 1,
            )
            # DG-2: the submission only spoke commands — every new op_log
            # row is a pre-existing command kind (capture·doc·run), never a
            # chat-owned write path. 채택 외 op_log 0건의 정확한 뜻: 챗 UI
            # 자체는 쓰기 경로를 추가하지 않는다.
            kinds = op_log_kinds_after(ops_before_chat)
            allowed = {"idea.capture", "doc.create", "run.start"}
            check(
                "F2-2c DG-2 챗 제출은 기존 커맨드만 발행(신규 쓰기 경로 0건)",
                len(kinds) > 0
                and set(kinds) <= allowed
                and "idea.capture" in kinds
                and "run.start" in kinds,
                ",".join(kinds),
            )
            check(
                "F2-2d 브리프·제안 카드의 집(리서치 문서)이 easy 서피스 전면 유지",
                page.locator("[data-testid=doc-tab][data-kind=research]").count() == 1,
            )

            # ── F2-3 needs_input 답변 뼈대 — 챗 UI의 정의 조각 ─────────
            # The e2e env carries no provider key, so the model never
            # reaches needs_input on its own. The fixture plants a run at
            # that state in the same store the daemon serves — the answer
            # field and the run.answer command are what F2 must prove.
            idea_id = query(
                "SELECT id FROM obj WHERE kind='idea' ORDER BY rowid DESC LIMIT 1"
            )[0][0]
            injected = "R_e2ef2chat01"
            query_write(
                "INSERT INTO run(id, task_id, worktree, branch, agent, mode, state,"
                " interrupted, outward_at, started_at, ended_at) VALUES"
                " (?, ?, NULL, NULL, 'researcher', 'research', 'needs_input', 0,"
                " NULL, ?, NULL)",
                (injected, idea_id, now_iso()),
            )
            query_write(
                "INSERT INTO run_log(run_id, seq, at, stream, line) VALUES"
                " (?, 1, ?, 'event', ?)",
                (
                    injected,
                    now_iso(),
                    json.dumps(
                        {"needs_input": True, "question": "어떤 사용자층부터 조사할까요?"}
                    ),
                ),
            )

            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.wait_for_selector("[data-surface=runPanel]", timeout=15000)
            page.wait_for_selector("[data-testid=run-question]", timeout=10000)
            check(
                "F2-3a needs_input 질문이 간편 챗 뼈대에 표시",
                "사용자층" in page.locator("[data-testid=run-question]").inner_text(),
            )
            check(
                "F2-3b 답변 입력 필드(챗 뼈대) 노출",
                page.locator("[data-testid=run-answer-input]").count() == 1,
            )
            page.locator("[data-testid=run-answer-input]").fill("구매 이력 고객부터")
            page.locator("[data-testid=run-answer-submit]").click()
            for _ in range(50):
                if query("SELECT COUNT(*) FROM op_log WHERE kind='run.answer'")[0][0] > 0:
                    break
                time.sleep(0.1)
            answered = query("SELECT COUNT(*) FROM op_log WHERE kind='run.answer'")[0][0]
            check(
                "F2-3c 답변은 run.answer 커맨드로만 발행(챗 고유 쓰기 0건)",
                answered == 1,
                str(answered),
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

            # ── F2-4 작업실 잔존(전문) + 참고 계수 ──────────────────────
            check(
                "F2-4a 전문 모드는 챗 도크를 숨긴다(현행 작업실 유지)",
                page.locator("[data-surface=chatDock]").count() == 0,
            )
            for surface in ("canvas", "docPanel", "pinPanel", "ideaInbox"):
                check(
                    f"F2-4b 전문 작업실 잔존: {surface}",
                    page.locator(f"[data-surface={surface}]").count() >= 1,
                )
            check(
                "F2-4c 전문 모드 런 패널(사이드 레일) 유지",
                page.locator("[data-surface=runPanel]").count() == 1,
            )
            pro_interactive = page.evaluate(INTERACTIVE_JS)
            print(
                f"     참고: 전문 모드 첫 화면 상호작용 요소 {pro_interactive}개 "
                "(동일 계수 규칙 — 게이트 아님, A-F2-1)"
            )

            page.locator("[data-testid=mode-switch]").click()
            page.wait_for_timeout(400)
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            check("F1-4c 원클릭 왕복 → 간편", mode == "easy", str(mode))
            check(
                "F1-4d 왕복 후 인박스 재은닉",
                page.locator("[data-testid=idea-inbox]").count() == 0,
            )
            check(
                "F2-4e 왕복 후 챗 도크 복원",
                page.locator("[data-surface=chatDock]").count() == 1,
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

            # ── F3-1 인앱 키 발급 가이드 — 콘솔 딥링크·단계·유료·BYOK 승계 ──
            # journey 참고치의 시작점: 키 없는 신규 사용자가 가이드를 여는 순간.
            journey_t0 = time.monotonic()
            page.locator("[data-testid=ai-settings-open]").click()
            page.wait_for_selector("[data-testid=ai-modal]", timeout=5000)
            check(
                "F3-1a 키 발급 가이드 블록 노출",
                page.locator("[data-testid=ai-key-guide]").count() == 1,
            )
            docs_href = (
                page.locator("[data-testid=ai-docs-link]").get_attribute("href") or ""
            )
            check(
                "F3-1b Anthropic 콘솔 딥링크",
                "console.anthropic.com" in docs_href,
                docs_href,
            )
            cost_note = page.locator("[data-testid=ai-cost-note]").inner_text()
            check(
                "F3-1c 유료 안내 + 요금 페이지 링크",
                "유료" in cost_note
                and page.locator("[data-testid=ai-pricing-link]").count() == 1,
                cost_note[:60],
            )
            byok_note = page.locator("[data-testid=ai-source-badge]").inner_text()
            check(
                "F3-1d BYOK 우선순위 문구 승계(입력 키>키체인>환경변수>규칙)",
                all(token in byok_note for token in ("지금 입력 키", "키체인", "환경변수")),
                byok_note[:80],
            )
            page.locator("[data-testid=ai-provider]").select_option("openai")
            docs_href2 = (
                page.locator("[data-testid=ai-docs-link]").get_attribute("href") or ""
            )
            check(
                "F3-1e OpenAI 콘솔 딥링크",
                "platform.openai.com" in docs_href2,
                docs_href2,
            )
            page.locator("[data-testid=ai-provider]").select_option("local")
            check(
                "F3-1f 로컬(규칙) 선택 시 무료·키 불필요 안내",
                "키 없이" in page.locator("[data-testid=ai-local-note]").inner_text()
                and "무료" in page.locator("[data-testid=ai-local-note]").inner_text(),
            )
            page.locator("[data-testid=ai-provider]").select_option("anthropic")

            # ── F3-4 구독 탭 연결점 정정 — 실개시·과금 없이 문구만 ─────────
            sub_title = (
                page.locator("[data-testid=ai-tab-subscription]").get_attribute("title")
                or ""
            )
            check(
                "F3-4a 구독 탭 'E2에서 제공 예정' 잘못된 표기 제거",
                "E2에서 제공 예정" not in sub_title,
                sub_title,
            )
            check(
                "F3-4b 구독 탭 준비 중 + BYOK·로컬 경로 안내",
                "준비 중" in sub_title and "키" in sub_title and "로컬" in sub_title,
                sub_title,
            )

            # ── F3-2 Ollama·로컬 런타임 자동 감지 ──────────────────────
            # 도달 여부는 환경 의존 — /api/ai 응답과 배너 노출이 정합이면 된다.
            with urllib.request.urlopen(
                f"http://127.0.0.1:{DAEMON_PORT}/api/ai", timeout=5
            ) as resp:
                ai_status = json.loads(resp.read())["status"]
            servers = ai_status.get("localServers", [])
            check(
                "F3-2a aiStatus.localServers — ollama·lmstudio 프로브 대상",
                sorted(entry["id"] for entry in servers) == ["lmstudio", "ollama"],
                str(servers),
            )
            reachable = [entry for entry in servers if entry["reachable"]]
            banner = page.locator("[data-testid=ai-local-detected]").count()
            check(
                "F3-2b 감지 배너 ↔ 도달 정합(미발견은 침묵)",
                banner == (1 if reachable else 0),
                f"reachable={len(reachable)} banner={banner}",
            )
            if reachable:
                check(
                    "F3-2c '설치 없이 로컬 AI 사용 가능' 안내 문구",
                    "로컬 AI" in page.locator("[data-testid=ai-local-detected]").inner_text()
                    and "키 없이" in page.locator("[data-testid=ai-local-detected]").inner_text(),
                )
            else:
                print(
                    "     참고: 이 환경에는 localhost 런타임이 없음 — 도달 양성 케이스는 "
                    "apps/daemon ai.test.ts의 aiFetch 모의로 커버"
                )
            page.locator("[data-testid=ai-close]").click()
            page.wait_for_timeout(300)

            # ── F3-3 폴백 정직화 — 통일 마커·간편 강조·영속 ─────────────
            mode = page.locator("[data-testid=mode-switch]").get_attribute("data-mode")
            if mode != "easy":
                page.locator("[data-testid=mode-switch]").click()
                page.wait_for_timeout(400)

            # 규칙 경로: 키 없는 브리프 요청 — daemon이 proposal.create(draft,
            # source='rule')를 리서치 문서에 파일링한다. '제안 만들기' 핀 추출기는
            # 이 시나리오에 핀이 없어 buildProposal이 거절한다 — 키 없는 사용자의
            # 실제 폴백 카드는 브리프다.
            with urllib.request.urlopen(
                f"http://127.0.0.1:{DAEMON_PORT}/api/projects", timeout=5
            ) as resp:
                project_id = json.loads(resp.read())["projects"][0]["id"]
            request = urllib.request.Request(
                f"http://127.0.0.1:{DAEMON_PORT}/api/projects/{project_id}/ai/proposal",
                data=json.dumps(
                    {"mode": "brief", "provider": "local", "topic": "취소 정책 조사"}
                ).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=15) as resp:
                brief = json.loads(resp.read())
            check(
                "F3-3a 규칙 브리프 발행(doc-chat origin — 구 오독 셀)",
                brief.get("source") == "rule",
                str(brief.get("source")),
            )
            op_view = query(
                "SELECT view FROM proposal_op ORDER BY rowid DESC LIMIT 1"
            )[0][0]
            check(
                "F3-3b 출처가 proposal_op.view JSON에 영속",
                json.loads(op_view).get("source") == "rule",
                op_view[:60],
            )

            # 카드는 리서치 문서 탭에 귀속 — 전환 후 통일 마커·간편 강조 확인.
            # (op 스트림이 화면을 리로드할 때까지 짧게 걸린다.)
            page.locator("[data-testid=doc-tab][data-kind=research]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=10000)
            badge = page.locator("[data-testid=proposal-source]")
            badge_text = badge.inner_text()
            check(
                "F3-3c 규칙 카드 data-source=rule",
                badge.get_attribute("data-source") == "rule",
                badge_text,
            )
            check(
                "F3-3d 통일 마커 'AI 없음·규칙 기반 제안'",
                "AI 없음" in badge_text and "규칙 기반" in badge_text,
                badge_text,
            )
            check(
                "F3-3e 간편 모드 폴백 강조 문구 노출(DG-4)",
                page.locator("[data-testid=proposal-source-note]").count() == 1,
            )
            journey_ms = int((time.monotonic() - journey_t0) * 1000)
            print(
                f"     참고(journey): 키 없는 신규 사용자 가이드→첫 제안 {journey_ms}ms — "
                "게이트 아님, F3 참고치"
            )

            # 재기동 후에도 같은 마커 — 영속 source가 origin 추측을 이긴다.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            page.locator("[data-testid=doc-tab][data-kind=research]").click()
            page.wait_for_selector("[data-testid=proposal-card]", timeout=10000)
            badge2_text = page.locator("[data-testid=proposal-source]").inner_text()
            check(
                "F3-3f 재기동 후에도 규칙 마커(구현 전: LLM으로 잘못 읽힘)",
                page.locator("[data-testid=proposal-source]").get_attribute("data-source")
                == "rule"
                and "규칙 기반" in badge2_text,
                badge2_text,
            )
            page.locator("[data-testid=proposal-reject]").click()
            page.wait_for_timeout(300)

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
    print(
        "\nPASS: E4 F1+F2+F3 — 간편 첫 세션 · 챗 퍼스트 입력층 · 챗 뼈대·답변 · "
        "커맨드만 발행(DG-2) · 모드 왕복 무손실(AC-4) · EntryGate 용어 · "
        "AI 접근 경로(키 가이드·로컬 감지·정직 마커·구독 연결점)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
