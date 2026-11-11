// Shared Chromium launch settings for the browser checks and screenshot scripts.
//
// - On a developer machine (Windows / macOS) the GPU is used through ANGLE.
// - On CI (GitHub Actions' Linux runners have no GPU) or with `--swiftshader`, WebGL runs on
//   SwiftShader, Chromium's software renderer. It's slower but renders the same frames, so
//   the logic checks behave identically.
import { chromium } from 'playwright';

export const isCI = !!process.env.CI;
export const softwareGL = process.argv.includes('--swiftshader') || (isCI && process.platform === 'linux');

export function browserArgs(extra = []) {
  const gl = softwareGL
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : process.platform === 'win32'
      ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--enable-gpu', '--ignore-gpu-blocklist'];
  return [...gl, '--autoplay-policy=no-user-gesture-required', ...extra];
}

/**
 * In-page stand-in for the Pointer Lock API, installed in every page the scripts open.
 *
 * The game requests pointer lock when a match starts. In the hidden test browser a real lock makes
 * Chromium call Windows' ClipCursor() with its invisible 1280×720 window at the top-left of the
 * primary screen, which traps the developer's actual mouse in that box until they switch apps.
 * The stand-in keeps what the page sees (pointerLockElement, pointerlockchange, a resolved promise)
 * without the browser ever locking, so the OS cursor is never touched.
 */
export function fakePointerLock() {
  let target = null;
  const changed = () => setTimeout(() => document.dispatchEvent(new Event('pointerlockchange', { bubbles: true })));
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get() { return target && target.isConnected && target.ownerDocument === this ? target : null; },
  });
  Element.prototype.requestPointerLock = function () {
    if (target !== this) { target = this; changed(); }
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function () {
    if (target) { target = null; changed(); }
  };
}

export async function launchBrowser(extra = []) {
  const browser = await chromium.launch({ args: browserArgs(extra) });
  // browser.newPage() goes through newContext(), so this covers every page the scripts open.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    await context.addInitScript(fakePointerLock);
    return context;
  };
  return browser;
}

/**
 * From the main menu: Play Now → pick the mode card → Start match (or Watch bots).
 * `mode` is 'snd' (Search & Destroy) or 'zombies'. `map` is the S&D map tile to pick
 * ('ACI HQ', 'ACI Building 2' or 'Randomize'); checks default to ACI HQ so their camera spots line up.
 */
export async function startFromMenu(page, mode = 'snd', spectate = false, side = '', map = 'ACI HQ') {
  await page.waitForSelector('.mm-item.primary', { timeout: 60000 });
  await page.click('.mm-item.primary');
  await page.waitForSelector(`.ms-card.${mode}`);
  await page.click(`.ms-card.${mode}`);
  if (mode === 'snd' && map) await page.click(`.ms-map >> text="${map}"`);
  if (side) await page.click(`.ms-panel .seg >> text=${side}`);
  await page.click(spectate ? '.ms-start >> text=Watch bots' : '.ms-start >> text=Start match');
}
