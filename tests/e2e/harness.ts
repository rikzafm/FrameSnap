/**
 * Playwright harness: launches the installed Chrome in a persistent context and loads the built
 * extension. Branded Chrome ignores --load-extension, so the extension is loaded over CDP
 * (`Extensions.loadUnpacked`, enabled by --enable-unsafe-extension-debugging). Set
 * E2E_CHANNEL=chromium to use Playwright's bundled Chromium instead (needs
 * `npx playwright install chromium`).
 *
 * Needs `npm run build` first (loads `dist/`, or `E2E_DIST`). The build is copied next to the
 * profile with its manifest patched to grant the fixture host (`127.0.0.1`), because a headless
 * run cannot click through the "remember this site" permission prompt. Nothing else changes.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

export interface Launched {
  context: BrowserContext;
  extensionId: string;
  /** Service worker, once it is running (it is woken by opening an extension page). */
  getWorker(): Promise<Worker>;
  userDataDir: string;
  /** Opens the popup page for `page`'s tab (the popup normally asks for the active tab). */
  openPopup(page: Page): Promise<Page>;
  /**
   * Opens a page and reloads it once. The first load after the extension is installed is not seen
   * by the worker's webRequest sniffer (found in real Chrome); a reload is.
   */
  visit(url: string): Promise<Page>;
  close(keepProfile?: boolean): Promise<void>;
}

export function distDir(): string {
  return resolve(process.env.E2E_DIST ?? 'dist');
}

/** Copy the build to a stable path beside the profile and grant 127.0.0.1. Same path = same extension id. */
function prepareBuild(dist: string, userDataDir: string): string {
  const copy = join(tmpdir(), `${basename(userDataDir)}-ext`);
  rmSync(copy, { recursive: true, force: true });
  cpSync(dist, copy, { recursive: true });
  const file = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { host_permissions?: string[] };
  manifest.host_permissions = [...(manifest.host_permissions ?? []), '*://127.0.0.1/*'];
  writeFileSync(file, JSON.stringify(manifest));
  return copy;
}

export async function launchExtension(
  opts: { userDataDir?: string; dist?: string } = {},
): Promise<Launched> {
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'framesnap-e2e-'));
  const build = prepareBuild(opts.dist ?? distDir(), userDataDir);
  const channel = process.env.E2E_CHANNEL ?? 'chrome';
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: channel === 'chromium' ? undefined : channel,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    acceptDownloads: true,
    args: [
      '--headless=new',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const session = await context.browser()!.newBrowserCDPSession();
  const loaded = (await session.send(
    'Extensions.loadUnpacked' as never,
    { path: build } as never,
  )) as {
    id: string;
  };
  const extensionId = loaded.id;
  // Navigate only once the worker runs, or its webRequest sniffer misses the first page's responses.
  const getWorker = async () =>
    context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 20_000 });
  await getWorker();
  return {
    context,
    extensionId,
    getWorker,
    userDataDir,
    async visit(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.reload();
      return page;
    },
    async openPopup(page) {
      const worker = await getWorker();
      const tab = await worker.evaluate(async (url) => {
        const [t] = await chrome.tabs.query({ url: `${url}*` });
        return { id: t!.id!, url: t!.url! };
      }, page.url());
      const popup = await context.newPage();
      await popup.addInitScript((t) => {
        chrome.tabs.query = (async () => [t]) as unknown as typeof chrome.tabs.query;
      }, tab);
      await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
      return popup;
    },
    async close(keepProfile = false) {
      await context.close();
      rmSync(build, { recursive: true, force: true });
      if (!keepProfile) rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
