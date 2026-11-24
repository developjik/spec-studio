"""DEV120 queue acceptance with the real daemon, SQLite and rendered browser."""
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from w4_doc import start_daemon, OUT_DIR

def request(path, command=None):
    body = None if command is None else json.dumps({'command': command}).encode()
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787'+path, data=body, headers={'Content-Type':'application/json'})) as response:
        return json.load(response)

def main():
    daemon = start_daemon()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1500})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto('http://127.0.0.1:5173')
            page.locator('[data-testid=daemon-status][data-status=connected]').wait_for()
            page.locator('[data-testid=entry-sample]').click()
            page.locator('[data-testid=doc-panel]').wait_for()
            page.locator('[data-testid=doc-add]').click()
            page.locator('[data-testid=doc-text-1]').fill('변경 전 원문')
            page.locator('[data-testid=doc-text-1]').press('Tab')
            expect(page.locator('[data-testid=doc-text-1]')).to_have_value('변경 전 원문')
            projects=request('/api/projects')['projects']
            project_id=projects[0]['id']
            detail=request('/api/projects/'+project_id)
            doc=detail['project']['docs'][0]
            block=doc['blocks'][0]
            cards=[]
            for n in range(3):
                result=request('/api/projects/'+project_id+'/commands', {'type':'proposal.create','docId':doc['id'],'source':'llm','draft':{'summary':f'큐 제안 {n+1}','patches':[{'blockId':block['id'],'text':f'새 문안 {n+1}'}]}})
                cards.append(result['project']['proposals'][-1]['id'])
            request('/api/projects/'+project_id+'/commands', {'type':'doc.create','title':'다른 문서','kind':'research'})
            page.reload()
            expect(page.locator('[data-testid=proposal-card]')).to_have_count(3)
            expect(page.locator('[data-testid=proposal-conflict]')).to_have_count(3)
            expect(page.locator('[data-testid=proposal-source]').first).to_have_text('LLM 제안')
            panel=page.locator('[data-testid=doc-panel]')
            page.locator('.toast').wait_for(state='hidden', timeout=10000)
            page.screenshot(path=str(OUT_DIR/'queue-desktop.png'), full_page=False)
            page.locator('[data-testid=proposal-defer]').first.click()
            expect(page.locator('[data-testid=proposal-card]').last).to_have_attribute('data-proposal-id',cards[0])
            page.reload()
            expect(page.locator('[data-testid=proposal-card]').last).to_have_attribute('data-proposal-id',cards[0])
            page.locator('[data-testid=proposal-reject]').first.click()
            expect(page.locator('[data-testid=proposal-card]')).to_have_count(2)
            page.locator('[data-testid=proposal-adopt]').first.click()
            expect(page.locator('[data-testid=proposal-card]')).to_have_count(1)
            expect(page.locator('[data-testid=proposal-adopt]')).to_be_disabled()
            expect(page.locator('[data-testid=proposal-stale]')).to_have_count(1)
            expect(page.locator('[data-testid=adopted-bar]')).to_contain_text(cards[2])
            # Revert belongs only to its own doc even while another tab is active.
            page.reload()
            page.locator('[data-testid=doc-tab]').nth(1).click()
            expect(page.locator('[data-testid=proposal-revert]')).to_have_count(0)
            page.locator('[data-testid=doc-tab]').first.click()
            expect(page.locator('[data-testid=proposal-revert]')).to_have_count(1)
            page.locator('[data-testid=proposal-revert]').click()
            expect(page.locator('[data-testid=doc-text-1]')).to_have_value('변경 전 원문')
            expect(page.locator('[data-testid=proposal-adopt]')).to_be_enabled()
            page.locator('[data-testid=proposal-adopt]').click()
            expect(page.locator('[data-testid=doc-text-1]')).to_have_value('새 문안 1')
            expect(page.locator('[data-testid=proposal-card]')).to_have_count(0)
            # Re-open three cards for a narrow-screen layout and persistence check.
            for n in range(3):
                request('/api/projects/'+project_id+'/commands', {'type':'proposal.create','docId':doc['id'],'source':'llm','draft':{'summary':f'모바일 제안 {n+1}','patches':[{'blockId':block['id'],'text':f'모바일 문안 {n+1}'}]}})
            page.reload()
            page.set_viewport_size({'width':390,'height':844})
            expect(page.locator('[data-testid=proposal-card]')).to_have_count(3)
            page.locator('[data-testid=proposal-card]').first.scroll_into_view_if_needed()
            page.locator('.toast').wait_for(state='hidden', timeout=10000)
            page.screenshot(path=str(OUT_DIR/'queue-mobile.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow'
            page.locator('[data-testid=maturity-toggle]').scroll_into_view_if_needed()
            page.locator('[data-testid=maturity-toggle]').click()
            checklist = page.locator('[data-testid=maturity-checklist]')
            expect(checklist).to_be_visible()
            bounds = checklist.bounding_box()
            assert bounds['y'] >= 56 and bounds['width'] <= 390 and bounds['height'] > 80, bounds
            page.screenshot(path=str(OUT_DIR/'queue-mobile-checklist.png'), full_page=True)
            assert not errors,errors
            browser.close()
        print('PASS: queue 3 cards, conflict before adopt, defer/reload, reject, stale block, attributed revert, independent adoption, mobile, no page errors')
    finally:
        daemon.terminate()
        daemon.wait(timeout=10)

if __name__=='__main__':
    main()
