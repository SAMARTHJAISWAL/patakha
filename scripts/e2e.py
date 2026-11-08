"""End-to-end checks in a real browser.

Usage: python scripts/e2e.py [base_url]     (default http://localhost:5173/)

Part 1 plays the built-in demo night. Part 2 gives Chromium a fake microphone
that plays a WAV this script writes itself (a quiet street, then single bangs
and a ladi at known times, independent of the app's own demo code), and checks
that the app counts them through the real microphone path. Part 3 checks the page.
"""
import math
import random
import struct
import sys
import tempfile
import time
import wave
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173/'
GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: object, detail: object = '') -> None:
    results.append((name, bool(ok), str(detail)))


def wait_for(fn, timeout: float = 10.0, step: float = 0.2):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end:
            return v
        time.sleep(step)


def stats(page: Page) -> dict:
    return page.evaluate('window.__patakha.stats()')


# ---- A test recording ------------------------------------------------------------

SINGLES = [2.0, 3.6, 5.1, 6.9, 8.4]
LADI_AT, LADI_N = 10.5, 20
LENGTH = 16.0


def write_wav(path: Path, fs: int = 48000) -> None:
    rnd = random.Random(42)
    n = int(LENGTH * fs)
    x = [(rnd.random() - 0.5) * 0.004 for _ in range(n)]

    def bang(t: float, amp: float, decay: float) -> None:
        i0 = int(t * fs)
        lp = 0.0
        for k in range(int(decay * fs * 6)):
            if i0 + k >= n:
                break
            lp += 0.4 * ((rnd.random() * 2 - 1) - lp)
            x[i0 + k] += amp * math.exp(-k / (decay * fs)) * lp

    for t in SINGLES:
        bang(t, 0.8, 0.06)
    for k in range(LADI_N):
        bang(LADI_AT + k * 0.08, 0.5, 0.02)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32767)) for v in x))


def open_app(browser, **ctx) -> tuple[Page, list[str]]:
    errors: list[str] = []
    page = browser.new_context(**ctx).new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(BASE)
    page.wait_for_function('window.__patakha !== undefined')
    return page, errors


def part_demo(p) -> None:
    browser = p.chromium.launch(headless=True, args=GPU + ['--autoplay-policy=no-user-gesture-required'], channel='chromium')
    page, errors = open_app(browser, viewport={'width': 1280, 'height': 900})
    check('demo: nothing is counted before starting', stats(page)['crackers'] == 0)
    page.get_by_role('button', name='Play the demo night').click()
    check('demo: the meter starts', wait_for(lambda: stats(page)['listening'], 5))
    check('demo: the level shows on the gauge', wait_for(lambda: page.locator('#level').inner_text() not in ('--', ''), 5), page.locator('#level').inner_text())
    check('demo: crackers are counted', wait_for(lambda: stats(page)['crackers'] >= 20, 25), stats(page))
    check('demo: a ladi is recognised', wait_for(lambda: stats(page)['ladis'] >= 1, 20), stats(page))
    check('demo: bursts are listed', wait_for(lambda: page.locator('#bursts li').count() >= 2, 15), page.locator('#bursts li').count())
    check('demo: the loudest level is shown', 'dB' in page.locator('#s-max').inner_text(), page.locator('#s-max').inner_text())
    check('demo: the numbers are marked as a demo', page.locator('#demo-badge').is_visible())
    # The phone pauses web audio (screen lock, a call): the page must say so, not freeze.
    page.evaluate("window.__patakha.app.engine.ctx.suspend()")
    check('pause: a paused microphone is announced', wait_for(lambda: page.locator('#paused').is_visible(), 4))
    check('pause: the reading says Paused', page.locator('#state').inner_text().lower() == 'paused', page.locator('#state').inner_text())
    secs = stats(page)['seconds']
    page.wait_for_timeout(1500)
    check('pause: nothing is measured while paused', stats(page)['seconds'] == secs)
    page.get_by_role('button', name='Carry on').click()
    check('pause: Carry on starts measuring again', wait_for(lambda: page.locator('#paused').is_hidden() and stats(page)['seconds'] > secs + 0.5, 5))
    check('pause: a note says how long it was paused', 'Paused for' in page.locator('#hint').inner_text(), page.locator('#hint').inner_text())
    page.evaluate("window.__patakha.app.engine.ctx.suspend()")
    wait_for(lambda: page.locator('#paused').is_visible(), 4)
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    check('pause: coming back to the page resumes by itself', wait_for(lambda: page.locator('#paused').is_hidden(), 5))
    n = stats(page)['logged']
    wait_for(lambda: stats(page)['logged'] > n, 20)
    lag = page.evaluate("Date.now() - window.__patakha.app.session.bursts.at(-1).at")
    check('pause: bursts after a pause carry the right clock time', 0 <= lag < 8000, f'{lag} ms behind now')
    page.evaluate("window.__patakha.app.engine.ctx.suspend()")
    wait_for(lambda: page.locator('#paused').is_visible(), 4)
    page.get_by_role('button', name='Stop').click()
    check('pause: Stop while paused leaves no paused message behind', page.locator('#paused').is_hidden() and 'Measuring again' not in page.locator('#hint').inner_text())
    page.get_by_role('button', name='Play the demo night').click()
    wait_for(lambda: stats(page)['crackers'] >= 20 and stats(page)['seconds'] > 8, 25)
    dose = page.locator('#s-dose').inner_text()
    check('demo: the noise dose is shown', dose == '<0.1%' or (dose.endswith('%') and float(dose[:-1]) > 0), dose)
    lit = page.evaluate('''() => {
      const c = document.getElementById('night-chart');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 || d[i + 1] > 120) n++;
      return n;
    }''')
    check('demo: the night chart draws bars', lit > 200, lit)
    check('demo: the night note names the busiest 10 minutes', 'Busiest' in page.locator('#night-note').inner_text())
    with page.expect_download() as dl:
        page.get_by_role('button', name='Share my night').click()
    from PIL import Image
    card = Image.open(dl.value.path())
    check('demo: Share my night makes a 1080 × 1350 picture', card.size == (1080, 1350) and dl.value.suggested_filename.endswith('.png'), (card.size, dl.value.suggested_filename))
    sound = page.get_by_role('button', name='Sound on')
    sound.click()
    check('demo: sound can be turned on', page.locator('#btn-sound').get_attribute('aria-pressed') == 'true' and page.locator('#btn-sound').inner_text() == 'Sound off')
    page.get_by_role('button', name='Sound off').click()
    check('demo: and off again', page.locator('#btn-sound').get_attribute('aria-pressed') == 'false')
    page.get_by_role('button', name='Stop').click()
    check("demo: stopping returns to tonight's real count, untouched", stats(page)['crackers'] == 0 and not page.locator('#demo-badge').is_visible(), stats(page))
    page.reload()
    page.wait_for_function('window.__patakha !== undefined')
    check('demo: nothing from the demo was saved', stats(page)['crackers'] == 0 and page.locator('#bursts li').count() == 0)
    check('demo: no console errors', not errors, ' | '.join(errors[:3]))
    browser.close()


def part_mic(p) -> None:
    wav = Path(tempfile.mkdtemp()) / 'street.wav'
    write_wav(wav)
    args = GPU + ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={wav}']
    browser = p.chromium.launch(headless=True, args=args, channel='chromium')
    page, errors = open_app(browser, viewport={'width': 1280, 'height': 900}, permissions=['microphone'])
    page.get_by_role('button', name='Start listening').click()
    check('mic: the microphone opens', wait_for(lambda: stats(page)['listening'], 8), page.locator('#error').inner_text() if page.locator('#error').is_visible() else '')
    check('mic: the other button offers the demo', page.locator('#btn-demo').inner_text() == 'Switch to the demo' and page.locator('#btn-listen').is_hidden())
    # The fake device loops the file; one pass is 16 s.
    got = wait_for(lambda: stats(page)['ladis'] >= 1 and stats(page)['seconds'] > LENGTH + 1, 40)
    s = stats(page)
    check('mic: the ladi in the recording is found', got, s)
    singles = page.evaluate("window.__patakha.app.session.bursts.filter(b => b.kind === 'bang').length")
    ladi = page.evaluate("window.__patakha.app.session.bursts.find(b => b.kind === 'ladi')")
    check('mic: every single bang is found', singles >= len(SINGLES), f'{singles} singles')
    check('mic: the ladi has about the right number of bangs', ladi and abs(ladi['count'] - LADI_N) <= 3, ladi and ladi['count'])
    page.get_by_role('button', name='Switch to the demo').click()
    check('mic: switching to the demo shows the demo count', wait_for(lambda: page.locator('#demo-badge').is_visible(), 5))
    page.get_by_role('button', name='Use the microphone').click()
    check("mic: and back shows tonight's count again", wait_for(lambda: not page.locator('#demo-badge').is_visible() and stats(page)['ladis'] >= 1, 5), stats(page))
    page.wait_for_timeout(500)
    before = stats(page)
    page.reload()
    page.wait_for_function('window.__patakha !== undefined')
    after = stats(page)
    check("mic: a reload keeps tonight's count", after['crackers'] == before['crackers'] > 0 and after['ladis'] == before['ladis'], (before['crackers'], after['crackers']))
    check('mic: and the list', page.locator('#bursts li').count() == min(after['logged'], 200) > 0, (page.locator('#bursts li').count(), after['logged']))
    with page.expect_download() as dl:
        page.get_by_role('button', name='Download CSV').click()
    lines = Path(dl.value.path()).read_text().strip().splitlines()
    check('mic: the CSV has a header and one row per burst, in local time', lines[0].startswith('local_time,kind') and len(lines) - 1 == after['logged'] and ('+' in lines[1][19:] or '-' in lines[1][19:]), lines[:2])
    # Two starts at once (a double tap, or mic then demo before the first finishes)
    # must not wire two audio streams into the count.
    page.evaluate("() => { const a = window.__patakha.app; void a.listen('mic'); void a.listen('demo'); }")
    page.wait_for_timeout(2500)
    secs0 = stats(page)['seconds']
    page.wait_for_timeout(2000)
    rate = (stats(page)['seconds'] - secs0) / 2
    check('mic: time advances at the real rate (one audio stream, not two)', 0.8 < rate < 1.2, f'{rate:.2f} s per s')
    page.get_by_role('button', name='Reset').click()
    page.keyboard.press('Escape')
    check('mic: closing Reset with Esc keeps the count', stats(page)['crackers'] > 0)
    page.get_by_role('button', name='Reset').click()
    page.get_by_role('button', name='Clear and start again').click()
    check('mic: reset clears the count', wait_for(lambda: stats(page)['crackers'] == 0 and page.locator('#bursts li').count() == 0, 3))
    page.get_by_role('button', name='Reset').click()
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    stop = page.locator('#btn-stop')
    if stop.is_visible():
        stop.click()
    check('mic: Stop stops listening', stop.is_hidden() and wait_for(lambda: not stats(page)['listening'], 5))
    check('mic: no console errors', not errors, ' | '.join(errors[:3]))
    browser.close()

    # No permission: a clear message, and the demo still works.
    browser = p.chromium.launch(headless=True, args=GPU + ['--use-fake-device-for-media-stream'], channel='chromium')
    page, errors = open_app(browser, viewport={'width': 1280, 'height': 900})
    page.context.grant_permissions([])
    page.evaluate("() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError')); }")
    page.get_by_role('button', name='Start listening').click()
    check('mic: refusing permission shows a helpful message', wait_for(lambda: page.locator('#error').is_visible() and 'demo' in page.locator('#error').inner_text(), 5), page.locator('#error').inner_text())
    browser.close()


def part_page(p) -> None:
    browser = p.chromium.launch(headless=True, args=GPU, channel='chromium')
    page, errors = open_app(browser, viewport={'width': 1280, 'height': 900})
    page_errors = list(errors)
    check('page: the title reads "patakha पटाखा", English first', page.locator('.brand').inner_text().split()[:2] == ['patakha', 'पटाखा'], page.locator('.brand').inner_text())
    check('page: the title is not a link', page.evaluate("document.querySelector('.brand').closest('a') === null"))
    links = page.evaluate("[...document.querySelectorAll('a')].map(a => a.href).filter(h => h.includes('github.com'))")
    check('page: nothing on the page links to GitHub', links == [], links)
    fonts = page.evaluate('''document.fonts.ready.then(() => [document.fonts.check('400 20px "Rozha One"', 'पटाखा'), document.fonts.check('800 20px "Manrope Variable"')])''')
    check('page: the Rozha One and Manrope fonts load', fonts == [True, True], fonts)
    url_before = page.url
    page.locator('.brand').click()
    page.wait_for_timeout(500)
    check('page: clicking the title stays on the page', page.url == url_before, page.url)
    m, errs = open_app(browser, viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    check('phone: no sideways scrolling', m.evaluate('document.documentElement.scrollWidth - innerWidth') == 0)
    small = m.evaluate("[...document.querySelectorAll('button, summary')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 32).map(b => b.textContent.trim())")
    check('phone: controls are big enough to tap', not small, small)
    m.locator('summary', has_text='Calibrate').click()
    m.locator('#offset').fill('125')
    check('phone: calibration changes the offset', '+5.0 dB' in m.locator('#offset-out').inner_text(), m.locator('#offset-out').inner_text())
    m.get_by_role('button', name='Back to default').click()
    check('phone: Back to default resets it', m.locator('#offset-out').inner_text() == '+0.0 dB', m.locator('#offset-out').inner_text())
    m.reload()
    m.wait_for_function('window.__patakha !== undefined')
    check('phone: the default sticks after a reload', m.locator('#offset').input_value() == '120', m.locator('#offset').input_value())
    check('page: no console errors', not page_errors and not errs, ' | '.join((page_errors + errs)[:3]))
    browser.close()


with sync_playwright() as p:
    part_demo(p)
    part_mic(p)
    part_page(p)

fails = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  ({detail})' if detail and not ok else ''))
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
