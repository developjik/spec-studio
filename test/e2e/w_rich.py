import os,json,urllib.request
from pathlib import Path
from playwright.sync_api import expect
from diagnostics import capturing_playwright
from w3_publish import start_daemon,OUT_DIR,WEB_URL

def main():
 daemon=start_daemon()
 try:
  with capturing_playwright(OUT_DIR) as p:
   b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(WEB_URL);page.locator('[data-testid=daemon-status][data-status=connected]').wait_for();page.locator('[data-testid=entry-sample]').click()
   page.get_by_role('button',name='+ 문단 추가',exact=True).click();page.locator('[data-testid=block-type-1]').select_option('table');page.get_by_label('표 2행 1열',exact=True).fill('주문');page.get_by_label('표 2행 1열',exact=True).blur();page.get_by_label('표 2행 2열',exact=True).fill('완료');page.get_by_label('표 2행 2열',exact=True).blur();page.get_by_role('button',name='행 추가',exact=True).click();page.get_by_role('button',name='열 추가',exact=True).click();page.get_by_label('표 3행 3열',exact=True).fill('세 번째 셀');page.get_by_label('표 3행 3열',exact=True).blur();page.locator('[data-testid=block-type-1]').select_option('paragraph');page.locator('[data-testid=block-type-1]').select_option('code');page.locator('[data-testid=block-type-1]').select_option('table');expect(page.get_by_label('표 3행 3열',exact=True)).to_have_value('세 번째 셀')
   page.get_by_role('button',name='+ 문단 추가',exact=True).last.click();page.locator('[data-testid=block-type-2]').select_option('code');page.get_by_label('코드 언어',exact=True).select_option('typescript');page.locator('[data-testid=doc-text-2]').fill('const greeting = "안녕하세요 <>&";\nconsole.log(greeting);');page.locator('[data-testid=doc-text-2]').blur();expect(page.locator('.rich-code')).to_contain_text('console.log')
   page.get_by_role('button',name='+ 문단 추가',exact=True).last.click();page.locator('[data-testid=block-type-3]').select_option('figure');page.get_by_label('그림 대체 텍스트',exact=True).fill('주문 상세 화면 캡처');page.get_by_label('그림 대체 텍스트',exact=True).blur();expect(page.locator('.rich-editor img')).to_be_visible();page.reload();expect(page.get_by_label('표 3행 3열',exact=True)).to_have_value('세 번째 셀');expect(page.get_by_label('그림 대체 텍스트',exact=True)).to_have_value('주문 상세 화면 캡처');expect(page.get_by_label('코드 언어',exact=True)).to_have_value('typescript');page.locator('.toast').wait_for(state='hidden',timeout=10000);page.screenshot(path=str(OUT_DIR/'rich-desktop.png'),full_page=True)
   page.get_by_role('button',name='출력 3종',exact=True).click();page.locator('[data-testid=output-tab-spec-html]').click();page.locator('[data-testid=output-html-preview]').wait_for();
   with page.expect_download() as download_info:page.locator('[data-testid=output-download-active]').click()
   html_file=OUT_DIR/'rich-output.html';download_info.value.save_as(str(html_file));output=b.new_page(viewport={'width':1100,'height':1500});output.goto(html_file.as_uri());expect(output.locator('.rich-table')).to_contain_text('세 번째 셀');expect(output.locator('.rich-code')).to_contain_text('console.log');expect(output.get_by_alt_text('주문 상세 화면 캡처')).to_be_visible();output.screenshot(path=str(OUT_DIR/'rich-html.png'),full_page=True);output.pdf(path=str(OUT_DIR/'rich-output.pdf'),format='A4',print_background=True);output.close();page.get_by_role('button',name='닫기',exact=True).click();
   page.set_viewport_size({'width':390,'height':844});page.locator('.doc-scroll').evaluate('(e)=>e.scrollTop=e.scrollHeight') if page.locator('.doc-panel').count() else None;page.screenshot(path=str(OUT_DIR/'rich-mobile.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth');assert not errors,errors;b.close()
  print('PASS rich table cells/add rows/columns, code language, figure capture alt, reload, HTML/PDF, mobile')
 finally:daemon.terminate();daemon.wait(timeout=10)
if __name__=='__main__':main()
