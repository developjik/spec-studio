"""DEV49: three screens, independent immutable pins, reopen and one all-screen publish."""
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import expect
from diagnostics import capturing_playwright
from w3_publish import start_daemon, mock_state, MOCK, OUT_DIR, WEB_URL


def request(path):
    with urllib.request.urlopen('http://127.0.0.1:8787'+path) as response:
        return json.load(response)


def main():
    daemon=start_daemon()
    try:
        with capturing_playwright(OUT_DIR) as p:
            browser=p.chromium.launch(args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1440,'height':1100})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(WEB_URL)
            page.locator('[data-testid=daemon-status][data-status=connected]').wait_for()
            page.locator('[data-testid=entry-sample]').click()
            page.locator('[data-testid=stage]').wait_for()
            first=page.get_by_label('현재 화면',exact=True).input_value()
            for name in ['주문 목록','결제 내역']:
                page.once('dialog',lambda d,n=name:d.accept(n))
                page.get_by_role('button',name='+ 화면 추가',exact=True).click()
                expect(page.locator('.screen-card')).to_have_count(2 if name=='주문 목록' else 3)
                stage=page.locator('[data-testid=stage]')
                for n in [1,2]:
                    box=stage.bounding_box()
                    page.mouse.click(box['x']+box['width']*(.2*n),box['y']+box['height']*.25)
                    page.locator('[data-testid=pin-title]').fill(f'{name} 핀 {n}')
                    page.locator('[data-testid=pin-save]').click()
                    expect(page.locator(f'[data-testid=pin-{n}]')).to_have_count(1)
            third=page.get_by_label('현재 화면',exact=True).input_value()
            page.get_by_label('상단 화면 전환',exact=True).select_option(first)
            expect(page.locator('[data-testid=pin-1]')).to_have_count(0)
            page.get_by_label('현재 화면',exact=True).select_option(third)
            expect(page.locator('[data-testid=pin-2]')).to_have_count(1)
            pid=request('/api/projects')['projects'][0]['id']
            state=request('/api/projects/'+pid)['project']
            assert len(state['screens'])==3 and len(state['pins'])==4,state
            assert len(set(d['screenId'] for d in state['docs']))==3,state['docs']
            page.reload()
            expect(page.get_by_label('현재 화면',exact=True)).to_have_value(third)
            expect(page.locator('[data-testid=pin-2]')).to_have_count(1)
            page.locator('.toast').wait_for(state='hidden',timeout=10000)
            page.screenshot(path=str(OUT_DIR/'screens-desktop.png'),full_page=True)
            page.get_by_role('button',name='Confluence 발행',exact=True).click()
            page.get_by_label('발행 화면',exact=True).select_option('all')
            page.locator('[data-testid=publish-base-url]').fill(MOCK['url'])
            page.locator('[data-testid=publish-space]').fill('SPEC')
            page.locator('[data-testid=publish-email]').fill('dev@example.com')
            page.locator('[data-testid=publish-token]').fill('local-test-only')
            page.locator('[data-testid=publish-preview]').wait_for()
            page.locator('[data-testid=publish-run]').click()
            expect(page.locator('[data-testid=publish-history] tbody tr')).to_have_count(3,timeout=45000)
            records=request('/api/projects/'+pid+'/publishes')['records']
            assert len(records)==3 and len(set(r['screenId'] for r in records))==3,records
            assert len(mock_state()['pages'])==3,mock_state()
            page.screenshot(path=str(OUT_DIR/'screens-publish.png'),full_page=True)
            page.locator('[data-testid=publish-close]').click()
            page.set_viewport_size({'width':390,'height':844})
            page.locator('.toast').wait_for(state='hidden',timeout=10000)
            page.screenshot(path=str(OUT_DIR/'screens-mobile.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'horizontal overflow'
            assert not errors,errors
            browser.close()
        print('PASS: three screens created through UI, 2+2 independent pins, switch/reload, screen docs, all-screen publish creates 3 distinct pages, mobile')
    finally:
        daemon.terminate();daemon.wait(timeout=10)

if __name__=='__main__':main()
