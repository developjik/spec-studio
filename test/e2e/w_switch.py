#!/usr/bin/env python3
"""End-to-end check for the daemon-mode project switcher (issue #4).

Runs a real daemon, a real SQLite file and Vite, then drives the browser:

  1. two projects whose screens share a title (1 pin vs 2 pins) live in one DB
  2. the most recently touched one is auto-opened at connect
  3. the switcher opens the other; pins follow, and document.title names it
  4. with the daemon gone (browser mode) no switcher is rendered

Environment (set by the runner):
  SPEC_STUDIO_DB   the SQLite file the daemon owns
  WEB_URL          default http://127.0.0.1:5173
  OUT_DIR          where screenshots go (default: downloads)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("SPEC_STUDIO_NODE", "node")
DB = os.environ["SPEC_STUDIO_DB"]
WEB_URL = os.environ.get("WEB_URL", "http://127.0.0.1:5173")
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "downloads"))
CHROMIUM = os.environ.get("CHROMIUM", "/workspace/.tools/chromium/pack/chromium")
DAEMON = ROOT / "apps" / "daemon" / "dist" / "daemon.mjs"
DAEMON_LOG = Path(os.environ.get("DAEMON_LOG", "/tmp/switche2e/daemon.log"))
API = "http://127.0.0.1:8787"

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
            with urllib.request.urlopen(f"{API}/api/health", timeout=0.5):
                return process
        except Exception:
            time.sleep(0.1)
    raise SystemExit("daemon did not become healthy")


def list_projects() -> list[dict]:
    with urllib.request.urlopen(f"{API}/api/projects", timeout=2) as response:
        return json.load(response)["projects"]


def add_pins(page: Page, titles: list[str]) -> None:
    stage = page.locator("[data-testid=stage]").bounding_box()
    if stage is None:
        raise SystemExit("stage is not laid out")
    for index, title in enumerate(titles):
        fx, fy = 0.25 + 0.2 * index, 0.3 + 0.15 * index
        page.mouse.click(stage["x"] + stage["width"] * fx, stage["y"] + stage["height"] * fy)
        page.locator("[data-testid=pin-title]").fill(title)
        page.locator("[data-testid=pin-body]").fill(f"{title} 본문")
        page.locator("[data-testid=type-function]").click()
        page.locator("[data-testid=pin-save]").click()
        page.wait_for_selector(f"[data-testid=pin-{index + 1}]", timeout=5000)
        page.wait_for_timeout(320)


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
            page.on("dialog", lambda dialog: dialog.accept())
            console_errors: list[str] = []
            page.on("pageerror", lambda error: console_errors.append(str(error)))

            page.goto(WEB_URL, wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=connected]", timeout=20000
            )
            check("빈 DB에서는 전환기가 없음", page.locator("[data-testid=project-switcher]").count() == 0)

            # ── 1. project A: sample screen + 1 pin ──────────────────────
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            add_pins(page, ["A 핀"])
            title_a = page.title()

            # ── 2. project B: same sample screen + 2 pins ────────────────
            page.get_by_role("button", name="새 화면").click()
            page.wait_for_selector("[data-testid=entry-sample]", timeout=10000)
            page.locator("[data-testid=entry-sample]").click()
            page.wait_for_selector("[data-testid=stage]", timeout=10000)
            add_pins(page, ["B 핀 1", "B 핀 2"])
            title_b = page.title()

            projects = list_projects()
            check("DB에 프로젝트 2개", len(projects) == 2, str(len(projects)))
            by_pins = {project["pins"]: project for project in projects}
            a, b = by_pins.get(1), by_pins.get(2)
            if a is None or b is None:
                raise SystemExit(f"unexpected projects: {projects}")
            check("두 화면 제목이 같음", a["screenTitle"] == b["screenTitle"], str(projects))
            check("창 제목이 프로젝트를 구분", title_a != title_b, f"{title_a!r} / {title_b!r}")
            check("창 제목에 B 프로젝트 이름", b["name"] in title_b, title_b)

            # ── 3. reload: the most recent (B) is auto-opened ────────────
            page.reload(wait_until="networkidle")
            switcher = page.locator("[data-testid=project-switcher]")
            switcher.wait_for(timeout=20000)
            check("접속 시 최근 프로젝트 자동 열기", switcher.get_attribute("data-project-id") == b["id"])
            check("B의 핀 2개", page.locator("[data-testid=pin-2]").count() == 1)
            options = switcher.locator("option").count()
            check("전환기에 프로젝트 2개", options == 2, str(options))

            # ── 4. switch to A ───────────────────────────────────────────
            switcher.select_option(a["id"])
            page.wait_for_selector(
                f"[data-testid=project-switcher][data-project-id='{a['id']}']", timeout=10000
            )
            page.wait_for_timeout(300)
            check("A로 전환 후 핀 1개", page.locator("[data-testid=pin-1]").count() == 1
                  and page.locator("[data-testid=pin-2]").count() == 0)
            check("전환 즉시 창 제목에 A 이름", a["name"] in page.title() and page.title() == title_a,
                  page.title())
            page.screenshot(path=str(OUT_DIR / "switch-a.png"))

            # ── 5. and back to B ─────────────────────────────────────────
            switcher.select_option(b["id"])
            page.wait_for_selector(
                f"[data-testid=project-switcher][data-project-id='{b['id']}']", timeout=10000
            )
            page.wait_for_timeout(300)
            check("B로 복귀 후 핀 2개", page.locator("[data-testid=pin-2]").count() == 1)
            check("B로 복귀 후 창 제목", page.title() == title_b, page.title())

            # ── 6. browser mode: no daemon, no switcher ──────────────────
            daemon.terminate()
            daemon.wait(timeout=10)
            page.reload(wait_until="networkidle")
            page.wait_for_selector(
                "[data-testid=daemon-status][data-status=offline]", timeout=20000
            )
            check("브라우저 모드에는 전환기 없음",
                  page.locator("[data-testid=project-switcher]").count() == 0)

            check("페이지 오류 없음", not console_errors, "; ".join(console_errors))
            browser.close()
    finally:
        if daemon.poll() is None:
            daemon.terminate()

    print("PASS" if not failures else f"FAIL ({len(failures)})")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
