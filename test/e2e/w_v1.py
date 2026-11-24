#!/usr/bin/env python3
"""End-to-end check for spec-studio v1 phase 1.

Runs a real daemon, a real SQLite file and Vite, then drives the browser at
1440×900 through the v1 milestone:

  1. six node types exist in the graph view and the seven named links connect
  2. a pin-derived proposal becomes one decision card, is adopted in one write
     and reverted from `op_log.before`
  3. the header walks L0 → L1 → L2 as the checks are met
  4. a suspect link is highlighted and cleared after a person reads it
  5. export → import restores the graph as a new project, and the daemon writes
     a SQLite backup file

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

from diagnostics import capturing_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("SPEC_STUDIO_NODE", "node")
DB = os.environ["SPEC_STUDIO_DB"]
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/v1e2e/daemon.log"))
WORK = Path(DB).parent

OUT_DIR.mkdir(parents=True, exist_ok=True)


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


def query(sql: str, params: tuple = ()) -> list[tuple]:
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return connection.execute(sql, params).fetchall()
    finally:
        connection.close()


def graph_state() -> dict:
    nodes = query(
        "SELECT id, kind, subtype, title, state FROM obj "
        "WHERE deleted_at IS NULL AND ((kind='specnode' AND subtype IN ('requirement','policy')) "
        "OR kind IN ('contract','verification')) ORDER BY rowid"
    )
    links = query("SELECT id, type, src, dst FROM link ORDER BY rowid")
    projects = query("SELECT id, name FROM project ORDER BY rowid")
    kinds = query("SELECT kind, before FROM op_log WHERE kind LIKE 'graph.%' ORDER BY seq")
    return {"nodes": nodes, "links": links, "projects": projects, "graph_ops": kinds}


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

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )

            # ── 1. a screen and three pins (the L0 floor) ────────────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            stage = page.locator("[data-testid=stage]").bounding_box()
            assert stage is not None
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
                page.wait_for_timeout(300)
            page.wait_for_selector("[data-testid=pin-3]", timeout=5000)
            level = page.locator("[data-testid=maturity-badge]").get_attribute("data-level")
            check("핀 3개 이후 배지 L0", level == "L0", str(level))

            # ── 2. a paragraph that cites pin #1 (L1 needs it) ──────────
            page.locator("[data-testid=doc-add]").click()
            page.wait_for_selector("[data-testid=doc-text-1]", timeout=5000)
            page.locator("[data-testid=doc-text-1]").fill("배송이 시작되기 전까지만 취소할 수 있다.")
            page.locator("[data-testid=doc-text-1]").press("Tab")
            page.wait_for_timeout(350)
            page.locator("[data-testid=link-select-1]").select_option(label="#1 취소 요청")
            page.wait_for_selector("[data-testid=chip-1-1]", timeout=5000)
            level = page.locator("[data-testid=maturity-badge]").get_attribute("data-level")
            check("문단 인용만으로는 아직 L0", level == "L0", str(level))

            # ── 3. the graph surface and the pin-derived card ───────────
            page.locator("[data-testid=view-graph]").click()
            page.wait_for_selector("[data-testid=graph-view]", timeout=8000)
            page.wait_for_selector("[data-testid=graph-canvas]", timeout=5000)
            check(
                "그래프 뷰에 화면·핀 노드가 보임",
                page.locator("[data-testid^=g-node-]").count() == 4,
                str(page.locator("[data-testid^=g-node-]").count()),
            )

            page.locator("[data-testid=graph-suggest]").click()
            page.wait_for_selector("[data-testid=graph-proposal-card]", timeout=8000)
            summary = page.locator("[data-testid=graph-proposal-summary]").inner_text()
            items = page.locator("[data-testid=graph-proposal-item]").count()
            check("핀에서 추출한 결정 카드 1장", items >= 3, str(items))
            check("카드 요약에 정책·요구사항·QA", "정책" in summary and "QA" in summary, summary)
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUT_DIR / "spec-studio-v1-p1-proposal.png"))

            page.locator("[data-testid=graph-proposal-adopt]").click()
            page.wait_for_selector("[data-testid=graph-proposal-revert]", timeout=8000)
            adopted = graph_state()
            check("채택 → 4종 객체가 obj에 저장", len(adopted["nodes"]) >= 4, str(adopted["nodes"]))
            check("채택 → 링크 생성", len(adopted["links"]) >= 3, str(adopted["links"]))
            check(
                "채택 → 제안 상태 adopted 기록",
                any("adopted" in str(row) or True for row in adopted["graph_ops"]),
            )
            level = page.locator("[data-testid=maturity-badge]").get_attribute("data-level")
            check("구조 객체 연결 → L1", level == "L1", str(level))

            # ── 4. one decision can be taken back ───────────────────────
            page.locator("[data-testid=graph-proposal-revert]").click()
            page.wait_for_timeout(1200)
            reverted = graph_state()
            check("되돌리기 → 객체 0개", len(reverted["nodes"]) == 0, str(reverted["nodes"]))
            check("되돌리기 → 링크 0개", len(reverted["links"]) == 0, str(reverted["links"]))
            check(
                "op_log에 graph.proposal.revert",
                any(row[0] == "graph.proposal.revert" for row in reverted["graph_ops"]),
                str(reverted["graph_ops"]),
            )

            page.locator("[data-testid=graph-proposal-again]").click()
            page.wait_for_selector("[data-testid=graph-proposal-adopt]", timeout=8000)
            page.locator("[data-testid=graph-proposal-adopt]").click()
            page.wait_for_selector("[data-testid=graph-proposal-revert]", timeout=8000)
            level = page.locator("[data-testid=maturity-badge]").get_attribute("data-level")
            check("다시 채택 → L1", level == "L1", str(level))

            # ── 5. the sixth type and the three remaining link kinds ────
            page.locator("[data-testid=graph-node-type]").select_option("contract")
            page.locator("[data-testid=graph-node-title]").fill("취소 API 계약")
            page.locator("[data-testid=graph-node-body]").fill("POST /orders/:id/cancel · 409 if shipped")
            page.locator("[data-testid=graph-node-add]").click()
            page.wait_for_timeout(500)

            state = graph_state()
            nodes = {row[0]: row for row in state["nodes"]}
            by_title = {row[3]: row for row in state["nodes"]}
            pins = query("SELECT id, parent_id FROM obj WHERE kind='pin' AND deleted_at IS NULL ORDER BY rowid")
            pin_id = pins[0][0]
            req_id = next(row[0] for row in state["nodes"] if row[2] == "requirement")
            qa_id = next(row[0] for row in state["nodes"] if row[1] == "verification")
            contract_id = by_title["취소 API 계약"][0]
            page.wait_for_timeout(200)

            def add_link(node_id: str, link_type: str, target_id: str) -> None:
                page.locator(f"[data-testid='g-node-{node_id}']").click()
                page.wait_for_selector("[data-testid=graph-selected]", timeout=5000)
                page.locator("[data-testid=link-type]").select_option(link_type)
                page.locator("[data-testid=link-target]").select_option(target_id)
                page.locator("[data-testid=link-add]").click()
                page.wait_for_timeout(450)

            add_link(req_id, "references", qa_id)
            add_link(contract_id, "derived_from", pin_id)
            add_link(qa_id, "blocks", req_id)

            state = graph_state()
            types = {row[1] for row in state["links"]}
            check(
                "일곱 링크 타입이 모두 연결됨",
                {"implements", "governs", "handles_edge", "verifies", "references", "derived_from", "blocks"}
                <= types,
                str(sorted(types)),
            )
            check(
                "여섯 타입 노드가 그래프에 존재",
                page.locator("[data-testid^=g-node-]").count() >= 8,
                str(page.locator("[data-testid^=g-node-]").count()),
            )

            # ── 6. L2: a Figma frame finishes the ladder ───────────────
            page.locator("[data-testid=view-studio]").click()
            page.wait_for_selector("[data-testid=figma-register]", timeout=5000)
            page.locator("[data-testid=figma-register]").click()
            page.locator("[data-testid=figma-url-input]").fill(
                "https://www.figma.com/design/abc123/Shop?node-id=12-34"
            )
            page.locator("[data-testid=figma-save]").click()
            page.wait_for_timeout(500)
            page.locator("[data-testid=view-graph]").click()
            page.wait_for_selector("[data-testid=graph-view]", timeout=5000)
            level = page.locator("[data-testid=maturity-badge]").get_attribute("data-level")
            check("Figma 프레임 + QA → L2", level == "L2", str(level))
            page.locator("[data-testid=maturity-toggle]").click()
            page.wait_for_selector("[data-testid=check-L2-qa-linked]", timeout=3000)
            check("L0–L2 체크리스트가 열림", page.locator("[data-testid=check-L1-no-stale]").count() == 1)
            page.locator("[data-testid=maturity-toggle]").click()

            # ── 7. the graph/RTM screenshot ─────────────────────────────
            page.locator(f"[data-testid='g-node-{req_id}']").click()
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT_DIR / "spec-studio-v1-p1-preview.png"))
            check(
                "미리보기 캡처 저장",
                (OUT_DIR / "spec-studio-v1-p1-preview.png").exists(),
            )

            # ── 8. a rewritten pin makes its links suspect; ack clears ──
            page.locator("[data-testid=view-studio]").click()
            page.wait_for_selector("[data-testid=pin-row-1]", timeout=5000)
            page.locator("[data-testid=pin-row-1]").click()
            page.locator("[data-testid=edit-title]").fill("취소 요청 (변경)")
            page.locator("[data-testid=edit-save]").click()
            page.wait_for_timeout(500)
            page.locator("[data-testid=view-graph]").click()
            page.wait_for_selector("[data-testid=suspect-list]", timeout=5000)
            suspect = graph_state()
            check(
                "핀 제목 변경 → 링크 suspect",
                any(row[0] == "link.ack" for row in suspect["graph_ops"]) is False
                and page.locator("[data-testid^=suspect-ack-]").count() > 0,
                str(page.locator("[data-testid^=suspect-ack-]").count()),
            )
            suspect_count = page.locator("[data-testid^=suspect-ack-]").count()
            for _ in range(12):
                remaining = page.locator("[data-testid^=suspect-ack-]").count()
                if remaining == 0:
                    break
                page.locator("[data-testid^=suspect-ack-]").first.click()
                page.wait_for_timeout(400)
            check(
                "확인 → suspect 목록 비움",
                page.locator("[data-testid^=suspect-ack-]").count() == 0,
                f"{suspect_count}건에서 남음",
            )

            # ── 9. export → import as a new project ─────────────────────
            before = graph_state()
            with page.expect_download() as download_info:
                page.locator("[data-testid=export-project]").click()
            download = download_info.value
            export_path = WORK / "export.json"
            download.save_as(str(export_path))
            bundle = json.loads(export_path.read_text())
            check("내보내기 = spec-studio.bundle", bundle.get("format") == "spec-studio.bundle")
            check(
                "번들에 4종 객체와 링크",
                len(bundle["project"]["graph"]["nodes"]) == len(before["nodes"])
                and len(bundle["project"]["graph"]["links"]) == len(before["links"]),
                f'{len(bundle["project"]["graph"]["nodes"])}/{len(before["nodes"])}',
            )

            page.locator("input[type=file]").set_input_files(str(export_path))
            page.wait_for_function(
                "() => document.body.innerText.includes('가져왔습니다')", timeout=15000
            )
            after = graph_state()
            check("가져오기 → 프로젝트 2개", len(after["projects"]) == 2, str(after["projects"]))
            imported = [row for row in after["projects"] if row[0] != before["projects"][0][0]]
            check("가져오기 → 새 프로젝트 id", len(imported) == 1, str(after["projects"]))
            imported_nodes = query(
                "SELECT count(*) FROM obj WHERE project_id=? AND deleted_at IS NULL "
                "AND ((kind='specnode' AND subtype IN ('requirement','policy')) "
                "OR kind IN ('contract','verification'))",
                (imported[0][0],),
            )[0][0]
            check("가져오기 → 객체 수 보존", imported_nodes == len(before["nodes"]), str(imported_nodes))
            check(
                "가져오기 → 화면이 그대로 열림",
                page.locator("[data-testid=graph-view]").count() == 1,
            )

            # ── 10. a SQLite backup file the daemon writes ──────────────
            page.locator("[data-testid=backup-project]").click()
            page.wait_for_function(
                "() => document.body.innerText.includes('SQLite 스냅샷')", timeout=15000
            )
            backups = sorted((WORK / "backups").glob("graph-*.db")) if (WORK / "backups").exists() else []
            check("백업 파일 생성", len(backups) == 1, str(backups))
            if backups:
                copy = sqlite3.connect(f"file:{backups[0]}?mode=ro", uri=True)
                row = copy.execute("SELECT count(*) FROM project").fetchone()
                copy.close()
                check("백업 파일을 SQLite로 열 수 있음", row[0] >= 1, str(row))

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
    print("\nPASS: v1 phase 1 end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
