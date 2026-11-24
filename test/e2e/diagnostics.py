"""Capture browser evidence before Playwright tears down on a harness failure."""
from contextlib import contextmanager
from pathlib import Path
from playwright.sync_api import sync_playwright


class TrackedBrowserType:
    def __init__(self, browser_type):
        self.browser_type = browser_type
        self.browsers = []

    def launch(self, **options):
        browser = self.browser_type.launch(**options)
        self.browsers.append(browser)
        return browser


class TrackedPlaywright:
    def __init__(self, playwright):
        self.chromium = TrackedBrowserType(playwright.chromium)


@contextmanager
def capturing_playwright(output):
    with sync_playwright() as playwright:
        tracked = TrackedPlaywright(playwright)
        try:
            yield tracked
        except BaseException:
            directory = Path(output)
            directory.mkdir(parents=True, exist_ok=True)
            for b, browser in enumerate(tracked.chromium.browsers):
                for c, context in enumerate(browser.contexts):
                    for p, page in enumerate(context.pages):
                        try:
                            page.screenshot(path=str(directory / f'failure-{b}-{c}-{p}.png'), timeout=5000)
                        except Exception:
                            # Evidence capture must never replace the original failure.
                            pass
            raise
