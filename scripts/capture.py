"""Screenshots, the social preview and the README GIF, from the demo night.

Usage: python scripts/capture.py [base_url]     (default http://localhost:4173/)
Writes docs/hero.png, docs/phone.png, docs/demo.gif and public/og.png.
Needs Playwright (with Chromium) and Pillow.
"""
import sys
import time
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
ROOT = Path(__file__).resolve().parent.parent
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']


def start_demo(page: Page, seconds: float) -> None:
    page.goto(BASE)
    page.wait_for_function('window.__patakha !== undefined')
    page.evaluate('document.fonts.ready')
    page.get_by_role('button', name='Play the demo night').click()
    page.wait_for_timeout(int(seconds * 1000))


def gif(page: Page, clip: dict, seconds: float, width: int) -> None:
    frames: list[tuple[Image.Image, int]] = []
    t_end = time.monotonic() + seconds
    last = time.monotonic()
    while time.monotonic() < t_end:
        img = Image.open(BytesIO(page.screenshot(clip=clip))).convert('RGB')
        img = img.resize((width, round(width * img.height / img.width)), Image.LANCZOS)
        now = time.monotonic()
        frames.append((img, 0))
        if len(frames) > 1:
            frames[-2] = (frames[-2][0], round((now - last) * 1000))
        last = now
    frames[-1] = (frames[-1][0], 2000)
    imgs = [f for f, _ in frames]
    sample = imgs[::3]
    sheet = Image.new('RGB', (imgs[0].width, imgs[0].height * len(sample)))
    for i, im in enumerate(sample):
        sheet.paste(im, (0, i * imgs[0].height))
    palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in imgs]
    out = ROOT / 'docs' / 'demo.gif'
    q[0].save(out, save_all=True, append_images=q[1:], duration=[d for _, d in frames], loop=0, optimize=True, disposal=1)
    print(f'docs/demo.gif: {len(q)} frames, {sum(d for _, d in frames) / 1000:.1f} s, {out.stat().st_size // 1024} KiB')


def main() -> None:
    (ROOT / 'docs').mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')

        desk = browser.new_context(viewport={'width': 1440, 'height': 960}).new_page()
        start_demo(desk, 1.5)
        # The GIF: the meter and the stats as the first ladi and rocket go off.
        box = desk.locator('.meter').bounding_box()
        stats = desk.locator('.stats').bounding_box()
        clip = {'x': box['x'] - 8, 'y': box['y'] - 8, 'width': stats['x'] + stats['width'] - box['x'] + 16, 'height': box['height'] + 16}
        gif(desk, clip, 14, 880)
        desk.wait_for_timeout(4000)
        desk.screenshot(path=str(ROOT / 'docs' / 'hero.png'))

        og = browser.new_context(viewport={'width': 1200, 'height': 630}).new_page()
        start_demo(og, 15)
        og.screenshot(path=str(ROOT / 'public' / 'og.png'))

        phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        start_demo(phone, 15)
        phone.evaluate('window.scrollTo(0, 0)')
        phone.screenshot(path=str(ROOT / 'docs' / 'phone.png'))
        browser.close()
    for f in ['docs/hero.png', 'docs/phone.png', 'public/og.png']:
        print(f, f'{(ROOT / f).stat().st_size // 1024} KiB')


if __name__ == '__main__':
    main()
