"""
End-to-end UI test of the web app in headless Chrome with a mocked backend.
- supabase-js is replaced by tests/fake-supabase.js (in-memory DB)
- the AI function and OpenStreetMap are answered by route handlers
Run: python3 tests/ui_test.py  (serves ./web on localhost)
"""
import json, os, re, sys, threading, time, functools, http.server, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'
SHOTS = Path('/tmp/masarifi_shots'); SHOTS.mkdir(exist_ok=True)
PORT = 8765
FAKE = (ROOT / 'tests' / 'fake-supabase.js').read_text(encoding='utf-8')

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def serve():
    handler = functools.partial(Quiet, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

def make_receipt(path):
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (3000, 4000), 'white')
    d = ImageDraw.Draw(img)
    for i, line in enumerate(['KAUFLAND FRECHEN', 'MILCH 1L   2x 1,25   2,50', 'BROT        8,00', 'RABATT     -1,00', 'SUMME EUR   9,50']):
        d.text((200, 300 + i * 300), line, fill='black')
    img.save(path, 'JPEG', quality=95)

analyze_calls = []

def analyze_handler(route, request):
    body = request.post_data_buffer or b''
    headers = request.headers
    meta = {}
    m = re.search(rb'name="meta"\r\n\r\n(.*?)\r\n--', body, re.S)
    if m:
        meta = json.loads(m.group(1).decode('utf-8'))
    has_audio = b'name="audio"' in body
    n_images = body.count(b'name="images"')
    analyze_calls.append({'audio': has_audio, 'images': n_images, 'meta': meta,
                          'auth': headers.get('authorization', ''), 'apikey': headers.get('apikey', ''),
                          'audio_type': re.search(rb'name="audio"; filename="[^"]*"\r\nContent-Type: ([^\r]+)', body).group(1).decode() if has_audio else None})
    if n_images:
        result = {'transcript': 'فاتورة من Kaufland مع تعليق: للبيت', 'needs_review': False, 'question': None, 'expenses': [{
            'spent_at_local': None, 'at_current_location': True, 'merchant': 'Kaufland', 'merchant_address': 'Europaallee 1, 50226 Frechen',
            'purpose': 'مشتريات البيت', 'note': None, 'payment_method': 'بطاقة', 'currency': 'EUR', 'total': 9.5, 'image_indexes': [0],
            'items': [
                {'name': 'حليب', 'name_original': 'MILCH 1L', 'category': 'أكل للبيت', 'quantity': 2, 'unit': 'لتر', 'unit_price': 1.25, 'total': 2.5},
                {'name': 'خبز', 'name_original': 'BROT', 'category': 'أكل للبيت', 'quantity': 1, 'unit': 'قطعة', 'unit_price': 8, 'total': 8},
                {'name': 'خصم', 'name_original': 'RABATT', 'category': 'أكل للبيت', 'quantity': 1, 'unit': None, 'unit_price': None, 'total': -1},
            ]}]}
    elif (meta.get('text') or '').find('قهوة') >= 0:
        result = {'transcript': meta.get('text'), 'needs_review': False, 'question': None, 'expenses': [{
            'spent_at_local': None, 'at_current_location': True, 'merchant': None, 'merchant_address': None, 'purpose': 'للمكتب',
            'note': None, 'payment_method': None, 'currency': 'EUR', 'total': 50, 'image_indexes': [],
            'items': [{'name': 'قهوة', 'name_original': None, 'category': 'قهوة ومشروبات', 'quantity': 1, 'unit': None, 'unit_price': None, 'total': 45}]}]}
    else:
        result = {'transcript': 'اشتريت علبتين دخان بعشرين يورو', 'needs_review': False, 'question': None, 'expenses': [{
            'spent_at_local': None, 'at_current_location': True, 'merchant': None, 'merchant_address': None, 'purpose': None,
            'note': None, 'payment_method': 'نقداً', 'currency': 'EUR', 'total': 20, 'image_indexes': [],
            'items': [{'name': 'دخان', 'name_original': 'Marlboro', 'category': 'دخان', 'quantity': 2, 'unit': 'علبة', 'unit_price': None, 'total': 20}]}]}
    time.sleep(0.3)
    route.fulfill(status=200, content_type='application/json; charset=utf-8',
                  headers={'Access-Control-Allow-Origin': '*'},
                  body=json.dumps({'ok': True, 'model': 'gemini-2.5-flash', 'usage': len(analyze_calls), 'result': result}, ensure_ascii=False))

def nominatim_handler(route, request):
    route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
                  body=json.dumps({'name': 'Kaufland', 'address': {'road': 'Europaallee', 'house_number': '1', 'town': 'Frechen'}, 'display_name': 'Kaufland, Europaallee 1, Frechen'}))

def main():
    httpd = serve()
    receipt = '/tmp/test_receipt.jpg'
    make_receipt(receipt)
    errors = []
    results = []
    def ok(name):
        results.append(name); print('  ✓', name)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
                                    args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = browser.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=1, locale='ar', timezone_id='Europe/Berlin',
                                  geolocation={'latitude': 50.9116, 'longitude': 6.8167}, permissions=['geolocation', 'microphone'],
                                  service_workers='block', accept_downloads=True, is_mobile=True, has_touch=True)
        ctx.route('**/vendor/supabase.js', lambda r, q: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        ctx.route('**/functions/v1/analyze', analyze_handler)
        ctx.route('https://nominatim.openstreetmap.org/**', nominatim_handler)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        answer = {'prompt': None}
        def on_dialog(d):
            if d.type == 'prompt':
                d.accept(answer['prompt'] if answer['prompt'] is not None else d.default_value)
            else:
                d.accept()
        page.on('dialog', on_dialog)

        page.goto(f'http://127.0.0.1:{PORT}/')
        # ── login screen
        expect(page.locator('#auth')).to_be_visible(timeout=8000)
        page.screenshot(path=str(SHOTS / '01_login.png'))
        page.fill('input[name=email]', 'test@example.invalid')
        page.fill('input[name=password]', 'wrong-password')
        page.click('#auth-submit')
        expect(page.locator('#auth-msg')).to_contain_text('غير صحيحة')
        ok('wrong password shows Arabic error')
        page.click('#auth-toggle')
        page.fill('input[name=password]', 'whatever-123')
        page.click('#auth-submit')
        expect(page.locator('#auth-msg')).to_contain_text('التسجيل مغلق')
        ok('second registration blocked message')
        page.click('#auth-toggle')
        page.fill('input[name=password]', 'test-password-123')
        page.click('#auth-submit')
        expect(page.locator('#app')).to_be_visible(timeout=8000)
        expect(page.locator('#recent')).to_contain_text('لا توجد مصاريف بعد')
        ok('login works, empty state shown')
        page.screenshot(path=str(SHOTS / '02_home_empty.png'))

        # ── voice flow
        page.click('#btn-mic')
        expect(page.locator('body')).to_have_class(re.compile('recording'))
        page.wait_for_timeout(2300)
        page.screenshot(path=str(SHOTS / '03_recording.png'))
        page.click('#btn-mic')
        expect(page.locator('.q-item.review')).to_be_visible(timeout=15000)
        expect(page.locator('.q-item.review')).to_contain_text('دخان')
        expect(page.locator('.q-item.review')).to_contain_text('× 10,00')
        call = analyze_calls[-1]
        assert call['audio'] and call['images'] == 0, call
        assert call['auth'] == 'Bearer fake-access-token' and call['apikey'].startswith('sb_publishable_'), call
        assert call['meta'].get('device_place') == 'Kaufland, Frechen', call['meta']
        assert call['audio_type'] in ('audio/webm', 'audio/ogg', 'audio/mp4'), call['audio_type']
        ok(f"voice recorded ({call['audio_type']}) → analyze called with auth, GPS place, review card shown")
        page.screenshot(path=str(SHOTS / '04_voice_review.png'), full_page=True)
        page.click('.q-item.review [data-act=save]')
        expect(page.locator('.q-item')).to_have_count(0, timeout=8000)
        expect(page.locator('#recent .exp')).to_have_count(1, timeout=8000)
        expect(page.locator('#sum-today')).to_contain_text('20,00')
        saved = page.evaluate('window.__fake.db.expenses[0]')
        assert saved['lat'] and saved['place_name'] == 'Kaufland, Frechen' and saved['source'] == 'voice', saved
        ok('voice expense saved with location, summary updated')

        # ── photo + voice comment flow
        page.set_input_files('#file-camera', receipt)
        expect(page.locator('#draft')).to_be_visible()
        expect(page.locator('#draft-thumbs .thumb')).to_have_count(1)
        page.click('#btn-mic'); page.wait_for_timeout(1500); page.click('#btn-mic')
        expect(page.locator('.q-item.review')).to_be_visible(timeout=15000)
        call = analyze_calls[-1]
        assert call['audio'] and call['images'] == 1, call
        expect(page.locator('.q-item.review')).to_contain_text('Kaufland')
        expect(page.locator('.q-item.review')).to_contain_text('MILCH 1L')
        page.locator('.q-item.review').screenshot(path=str(SHOTS / '05_receipt_review.png'))
        page.click('.q-item.review [data-act=save]')
        expect(page.locator('.q-item')).to_have_count(0, timeout=8000)
        uploads = page.evaluate("window.__fake.log.filter(x => x.upload)")
        assert len(uploads) == 1 and uploads[0]['size'] < 1_500_000, uploads
        rec = page.evaluate("window.__fake.db.expenses.find(e => e.merchant === 'Kaufland')")
        assert rec['receipt_paths'] and rec['source'] == 'photo_voice' and abs(rec['total'] - 9.5) < 0.001, rec
        ok(f"photo+voice: image compressed to {uploads[0]['size']//1024} KB, uploaded, expense saved (9,50 €)")

        # ── typed text with mismatch → edit
        page.fill('#text-input', 'قهوة للمكتب 50')
        page.press('#text-input', 'Enter')
        expect(page.locator('.q-item.review .warnline')).to_be_visible(timeout=15000)
        ok('total mismatch warning shown')
        page.click('.q-item.review [data-act=edit]')
        expect(page.locator('#ed')).to_be_visible()
        page.fill('.ed-item .f-total', '50')
        expect(page.locator('#ed-sum')).to_contain_text('50,00')
        page.wait_for_timeout(400); page.screenshot(path=str(SHOTS / '06_editor.png'))
        page.click('#ed button[type=submit]')
        expect(page.locator('#sheet')).to_be_hidden(timeout=8000)
        expect(page.locator('.q-item')).to_have_count(0, timeout=8000)
        coffee = page.evaluate("window.__fake.db.expenses.find(e => e.purpose === 'للمكتب')")
        assert abs(coffee['total'] - 50) < 0.001 and coffee['source'] == 'text', coffee
        ok('edit + save from review works (50,00 €)')

        # ── offline: entry queued, processed when back online
        ctx.set_offline(True)
        page.wait_for_timeout(300)
        expect(page.locator('#offline')).to_be_visible()
        page.click('#btn-mic'); page.wait_for_timeout(1500); page.click('#btn-mic')
        expect(page.locator('.q-item.waiting')).to_be_visible(timeout=15000)
        page.screenshot(path=str(SHOTS / '07_offline_waiting.png'))
        n_before = len(analyze_calls)
        ctx.set_offline(False)
        expect(page.locator('.q-item.review')).to_be_visible(timeout=15000)
        assert len(analyze_calls) == n_before + 1
        page.click('.q-item.review [data-act=save]')
        expect(page.locator('.q-item')).to_have_count(0, timeout=8000)
        ok('offline recording kept and analysed automatically when online')

        # ── persistence: reload keeps nothing pending and data visible
        expect(page.locator('#recent .exp')).to_have_count(4, timeout=8000)
        page.screenshot(path=str(SHOTS / '08_home_filled.png'), full_page=True)

        # ── history + detail + delete
        page.click('.tabs [data-view=history]')
        expect(page.locator('#h-list .exp')).to_have_count(4, timeout=8000)
        page.fill('#h-search', 'milch')
        expect(page.locator('#h-list .exp')).to_have_count(1)
        page.fill('#h-search', '')
        page.screenshot(path=str(SHOTS / '09_history.png'), full_page=True)
        page.locator('#h-list .exp').first.click()
        expect(page.locator('#d-edit')).to_be_visible()
        page.wait_for_timeout(400); page.screenshot(path=str(SHOTS / '10_detail.png'))
        page.click('#d-del')
        expect(page.locator('#sheet')).to_be_hidden(timeout=8000)
        expect(page.locator('#h-list .exp')).to_have_count(3, timeout=8000)
        ok('history search, detail view and delete work')

        # ── reports
        page.click('.tabs [data-view=reports]')
        expect(page.locator('.kpi.main')).to_be_visible(timeout=8000)
        body = page.locator('#r-body').inner_text()
        assert 'حسب الفئة' in body and 'دخان' in body, body[:400]
        page.locator('.cat-row', has_text='دخان').first.click()
        expect(page.locator('.cat-items')).to_contain_text('علبة')
        page.locator('#r-body rect.hit').nth(5).click()
        page.screenshot(path=str(SHOTS / '11_reports.png'), full_page=True)
        with page.expect_download() as dl:
            page.click('#r-export')
        path = dl.value.path()
        csv = Path(path).read_text(encoding='utf-8-sig')
        assert csv.startswith('التاريخ;الوقت') and ';' in csv, csv[:200]
        page.click('#r-periods [data-k=year]')
        expect(page.locator('.kpi.main')).to_contain_text('سنة')
        ok('reports: categories, drill-down with quantities, chart, CSV export, year view')

        # ── settings: usage + rename category (prompt)
        page.click('.tabs [data-view=settings]')
        expect(page.locator('#s-usage')).to_have_text('3', timeout=8000)
        page.screenshot(path=str(SHOTS / '12_settings.png'), full_page=True)
        answer['prompt'] = 'أكل وبقالة'
        page.locator('#s-cats .lc-row', has_text='أكل للبيت').click()
        page.wait_for_timeout(600)
        cats = page.evaluate("[...new Set(window.__fake.db.expense_items.map(i => i.category))]")
        assert 'أكل وبقالة' in cats and 'أكل للبيت' not in cats, cats
        ok('rename/merge category works')

        # ── manual entry
        page.click('.tabs [data-view=add]')
        page.click('#btn-manual')
        expect(page.locator('#ed')).to_be_visible()
        page.fill('.ed-item .f-name', 'بنزين')
        page.fill('.ed-item .f-cat', 'سيارة ووقود')
        page.fill('.ed-item .f-qty', '40')
        page.fill('.ed-item .f-price', '1,80')
        expect(page.locator('.ed-item .f-total')).to_have_value('72')
        page.click('#ed button[type=submit]')
        expect(page.locator('#sheet')).to_be_hidden(timeout=8000)
        fuel = page.evaluate("window.__fake.db.expense_items.find(i => i.name === 'بنزين')")
        assert abs(fuel['total'] - 72) < 0.001 and fuel['quantity'] == 40, fuel
        ok('manual entry with qty × price auto-calculation (40 × 1,80 = 72)')

        # ── logout
        page.click('.tabs [data-view=settings]')
        page.click('#s-logout')
        expect(page.locator('#auth')).to_be_visible(timeout=8000)
        ok('logout')

        # ── dark mode screenshot
        page2 = browser.new_page(viewport={'width': 412, 'height': 915}, color_scheme='dark')
        page2.route('**/vendor/supabase.js', lambda r, q: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        page2.goto(f'http://127.0.0.1:{PORT}/')
        expect(page2.locator('#auth')).to_be_visible(timeout=8000)
        page2.screenshot(path=str(SHOTS / '13_login_dark.png'))
        page2.close()

        # ── service worker: installs and caches the app shell
        ctx2 = browser.new_context(viewport={'width': 412, 'height': 915})
        ctx2.route('**/vendor/supabase.js', lambda r, q: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        p3 = ctx2.new_page()
        p3.on('pageerror', lambda e: errors.append(f'pageerror(sw): {e}'))
        p3.goto(f'http://127.0.0.1:{PORT}/')
        p3.evaluate('navigator.serviceWorker.ready.then(() => true)')
        p3.wait_for_timeout(800)
        keys = p3.evaluate("caches.keys().then(async ks => { const c = await caches.open(ks[0]); return (await c.keys()).map(r => new URL(r.url).pathname); })")
        assert '/' in keys and '/app.js' in keys and '/vendor/supabase.js' in keys, keys
        ok(f'service worker installed, {len(keys)} files cached for offline start')
        ctx2.close()

        browser.close()
    httpd.shutdown()

    real_errors = [e for e in errors if 'favicon' not in e]
    if real_errors:
        print('\nERRORS:'); [print('  ', e) for e in real_errors]
        sys.exit(1)
    print(f'\nALL {len(results)} UI CHECKS PASSED – screenshots in {SHOTS}')

if __name__ == '__main__':
    main()
