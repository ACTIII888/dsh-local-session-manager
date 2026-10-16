/**
 * 截图脚本: 用夹具数据渲染构建产物, 生成界面截图到 test/screenshots.
 *
 *   node test/shot.mjs
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/14646/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright");

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtureDir = join(root, "test", "fixture", ".dsh");
const appPath = join(root, "dsh-session-manager.html");
const outDir = join(root, "test", "screenshots");

async function walk(dir, base = dir, files = [], dirs = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");

    if (entry.isDirectory()) {
      dirs.push(rel);
      await walk(full, base, files, dirs);
    } else {
      files.push(rel);
    }
  }

  return { files, dirs };
}

let activeBrowser = null;

async function main() {
  const manifestData = await walk(fixtureDir);
  const files = manifestData.files;
  const dirs = manifestData.dirs;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);

    if (path === "/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files, dirs }));
      return;
    }

    if (path.startsWith("/fixture/")) {
      const rel = path.slice("/fixture/".length);
      if (rel.includes("..")) {
        res.writeHead(400).end("bad path");
        return;
      }
      const filePath = join(fixtureDir, rel);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("not a file");
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": (await stat(filePath)).size });
      createReadStream(filePath).pipe(res);
      return;
    }

    if (path === "/" || path === "/app/dsh-session-manager.html") {
      const html = await readFile(appPath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404).end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  await mkdir(outDir, { recursive: true });

  activeBrowser = await chromium.launch();
  const browser = activeBrowser;
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });

  await page.goto(`${origin}/app/dsh-session-manager.html`);

  await page.evaluate(async () => {
    const manifest = await (await fetch("/manifest.json")).json();
    const rootHandle = await navigator.storage.getDirectory();

    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }

    for (const rel of manifest.dirs) {
      let dir = rootHandle;
      for (const part of rel.split("/")) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
    }

    for (const rel of manifest.files) {
      const parts = rel.split("/");
      let dir = rootHandle;

      for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }

      const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await handle.createWritable();
      await writable.write(await (await fetch("/fixture/" + rel)).blob());
      await writable.close();
    }
  });

  await page.click("#pick-directory-button");
  await page.click("#modal-confirm-button");
  await page.waitForFunction(() => window.__dsh && window.__dsh.state.sessions.length > 0, null, { timeout: 120000 });
  await page.waitForFunction(() => !window.__dsh.state.enrichProgress && !window.__dsh.state.decodeProgress, null, { timeout: 120000 });
  await page.click("#session-list .session-item:nth-child(1) .session-main");
  await page.waitForFunction(() => document.querySelectorAll("#detail-preview .conversation-item").length > 0, null, { timeout: 120000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, "01-overview-light.png") });

  await page.click('#conversation-filter .conversation-filter-button[data-kind="all"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const scroll = document.querySelector("#detail-scroll");
    const preview = document.querySelector("#detail-preview");
    const block = preview && preview.closest(".detail-block");

    if (scroll && block) {
      scroll.scrollTop += block.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 6;
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "02-conversation-all-light.png") });

  await page.click("#theme-toggle-button");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "03-conversation-all-dark.png") });

  await page.evaluate(() => {
    const scroll = document.querySelector("#detail-scroll");

    if (scroll) {
      scroll.scrollTop = 0;
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "04-overview-dark.png") });

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  console.log("screenshots written to " + outDir);
}

main().catch(async (error) => {
  console.error("SHOT ERROR:", error);

  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
  }

  process.exitCode = 1;
});