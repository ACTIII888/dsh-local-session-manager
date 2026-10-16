/**
 * 校验直接以 file:// 双击打开构建产物时的完整可用性:
 * 安全上下文, showDirectoryPicker, Blob worker, zstd 解码, 会话列表渲染.
 *
 * 浏览器不允许 file:// 页面写 OPFS, 因此这里用内存文件系统模拟用户选择的目录.
 *
 *   node test/file-url-check.mjs
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/14646/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright");

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtureDir = join(root, "test", "fixture", ".dsh");
const appPath = join(root, "dsh-session-manager.html");

async function walk(dir, base = dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");

    if (entry.isDirectory()) {
      await walk(full, base, files);
    } else {
      files.push(rel);
    }
  }

  return files;
}

const initScript = () => {
  const notFound = () => new DOMException("not found", "NotFoundError");

  class MemoryFileHandle {
    constructor(name, bytes) {
      this.kind = "file";
      this.name = name;
      this.bytes = bytes;
    }

    async getFile() {
      return new File([this.bytes], this.name, { lastModified: 1792035476523 });
    }
  }

  class MemoryDirectoryHandle {
    constructor(name) {
      this.kind = "directory";
      this.name = name;
      this.children = new Map();
    }

    async *values() {
      for (const child of this.children.values()) {
        yield child;
      }
    }

    async *entries() {
      for (const entry of this.children.entries()) {
        yield entry;
      }
    }

    async getDirectoryHandle(name, options) {
      const existing = this.children.get(name);

      if (existing) {
        if (existing.kind !== "directory") {
          throw new DOMException("not a directory", "TypeMismatchError");
        }

        return existing;
      }

      if (!options || !options.create) {
        throw notFound();
      }

      const created = new MemoryDirectoryHandle(name);
      this.children.set(name, created);
      return created;
    }

    async getFileHandle(name, options) {
      const existing = this.children.get(name);

      if (existing) {
        if (existing.kind !== "file") {
          throw new DOMException("not a file", "TypeMismatchError");
        }

        return existing;
      }

      if (!options || !options.create) {
        throw notFound();
      }

      const created = new MemoryFileHandle(name, new Uint8Array(0));
      this.children.set(name, created);
      return created;
    }

    async removeEntry(name, options) {
      const existing = this.children.get(name);

      if (!existing) {
        throw notFound();
      }

      if (existing.kind === "directory" && existing.children.size && !(options && options.recursive)) {
        throw new DOMException("directory not empty", "InvalidModificationError");
      }

      this.children.delete(name);
    }
  }

  window.__mockRoot = new MemoryDirectoryHandle(".dsh");
  window.__mockSeed = (items) => {
    for (const item of items) {
      const parts = item.rel.split("/");
      let dir = window.__mockRoot;

      for (const part of parts.slice(0, -1)) {
        if (!dir.children.has(part)) {
          dir.children.set(part, new MemoryDirectoryHandle(part));
        }

        dir = dir.children.get(part);
      }

      const binary = atob(item.base64);
      const bytes = new Uint8Array(binary.length);

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      dir.children.set(parts[parts.length - 1], new MemoryFileHandle(parts[parts.length - 1], bytes));
    }
  };
  window.showDirectoryPicker = async () => window.__mockRoot;
};

let activeBrowser = null;

async function main() {
  const files = await walk(fixtureDir);
  activeBrowser = await chromium.launch();
  const browser = activeBrowser;
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];

  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(initScript);
  await page.goto(pathToFileURL(appPath).href);

  const caps = await page.evaluate(() => ({
    protocol: location.protocol,
    secureContext: window.isSecureContext,
    showDirectoryPicker: typeof window.showDirectoryPicker,
    worker: typeof Worker,
    appBooted: Boolean(window.__dsh && window.__dsh.state),
  }));
  console.log("caps:", JSON.stringify(caps));

  const workerProbe = await page.evaluate(async () => {
    const source = document.querySelector("#dsh-worker-source").textContent;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("no-response"), 5000);

      worker.addEventListener("error", (event) => {
        clearTimeout(timer);
        resolve("error: " + (event.message || "unknown"));
      });
      worker.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve("responded");
        void event;
      });
      worker.postMessage({ jobId: 1, cmd: "probe", buffer: new ArrayBuffer(8), options: null });
    });

    worker.terminate();
    URL.revokeObjectURL(url);
    return result;
  });
  console.log("worker probe:", workerProbe);

  for (let index = 0; index < files.length; index += 6) {
    const chunk = files.slice(index, index + 6);
    const payload = [];

    for (const rel of chunk) {
      payload.push({ rel, base64: (await readFile(join(fixtureDir, rel))).toString("base64") });
    }

    await page.evaluate((items) => window.__mockSeed(items), payload);
  }

  console.log("seeded " + files.length + " files into memory fs");

  await page.click("#pick-directory-button");
  await page.click("#modal-confirm-button");
  await page.waitForFunction(() => window.__dsh && window.__dsh.state.sessions.length > 0, null, { timeout: 120000 });
  await page.waitForFunction(() => !window.__dsh.state.enrichProgress && !window.__dsh.state.decodeProgress, null, { timeout: 120000 });

  const scan = await page.evaluate(() => ({
    total: window.__dsh.state.sessions.length,
    real: window.__dsh.state.sessions.filter((session) => !session.cacheOnly).length,
    cacheOnly: window.__dsh.state.sessions.filter((session) => session.cacheOnly).length,
    title: window.__dsh.state.filteredSessions[0] && window.__dsh.state.filteredSessions[0].title,
  }));
  console.log("scan:", JSON.stringify(scan));

  await page.click("#session-list .session-item:nth-child(1) .session-main");
  await page.waitForFunction(() => document.querySelectorAll("#detail-preview .conversation-item").length > 0, null, { timeout: 120000 });

  const detail = await page.evaluate(() => ({
    items: document.querySelectorAll("#detail-preview .conversation-item").length,
    kinds: Array.from(document.querySelectorAll("#detail-preview .conversation-item")).reduce((accumulator, node) => {
      const kind = Array.from(node.classList).find((name) => name !== "conversation-item" && name !== "is-minor") || "unknown";
      accumulator[kind] = (accumulator[kind] || 0) + 1;
      return accumulator;
    }, {}),
    overview: document.querySelector("#detail-overview").textContent.length,
  }));
  console.log("detail:", JSON.stringify(detail));

  console.log("pageErrors:", JSON.stringify(pageErrors));
  console.log("consoleErrors:", JSON.stringify(consoleErrors.slice(0, 5)));

  await browser.close();

  const ok = caps.protocol === "file:"
    && caps.secureContext === true
    && caps.showDirectoryPicker === "function"
    && workerProbe === "responded"
    && scan.real === 12
    && scan.cacheOnly === 1
    && Boolean(scan.title)
    && detail.items > 0
    && pageErrors.length === 0
    && consoleErrors.length === 0;

  console.log(ok ? "FILE-URL CHECK PASSED" : "FILE-URL CHECK FAILED");
  process.exitCode = ok ? 0 : 1;
}

main().catch(async (error) => {
  console.error("PROBE ERROR:", error);

  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
  }

  process.exitCode = 1;
});