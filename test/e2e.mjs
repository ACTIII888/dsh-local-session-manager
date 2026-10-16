/**
 * 端到端测试: 用 Playwright 打开构建产物, 通过 OPFS 伪造 .dsh 目录, 验证全部功能.
 *
 *   node test/e2e.mjs
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/14646/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright");

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtureDir = join(root, "test", "fixture", ".dsh");
const appPath = join(root, "dsh-session-manager.html");

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

const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

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
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`server on ${origin}, fixture files: ${files.length}, dirs: ${dirs.length}`);

  const downloadDir = await mkdtemp(join(tmpdir(), "dsh-e2e-"));
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];

  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });

  await page.goto(`${origin}/app/dsh-session-manager.html`);

  const copyStarted = Date.now();
  const copied = await page.evaluate(async () => {
    const manifest = await (await fetch("/manifest.json")).json();
    const rootHandle = await navigator.storage.getDirectory();

    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }

    for (const rel of manifest.dirs) {
      const parts = rel.split("/");
      let dir = rootHandle;

      for (const part of parts) {
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
      const response = await fetch("/fixture/" + rel);

      await writable.write(await response.blob());
      await writable.close();
    }

    return manifest.files.length;
  });

  check("fixture copied into OPFS", copied === files.length, `${copied} files in ${Date.now() - copyStarted}ms`);
  console.log("[step] opfs ready");
  // ---- 扫描 ----
  const scanStarted = Date.now();
  await page.click("#pick-directory-button");
  await page.click("#modal-confirm-button");
  await page.waitForFunction(() => window.__dsh && window.__dsh.state.sessions.length > 0, null, { timeout: 120000 });
  await page.waitForFunction(() => !window.__dsh.state.enrichProgress, null, { timeout: 120000 });

  const summary = await page.evaluate(() => {
    const state = window.__dsh.state;
    return {
      total: state.sessions.length,
      real: state.sessions.filter((s) => !s.cacheOnly).length,
      cacheOnly: state.sessions.filter((s) => s.cacheOnly).length,
      staleDirs: state.staleDirs.length,
      legacyFiles: state.legacyFiles.length,
      emptyProjects: state.emptyProjects.length,
      firstTitle: state.filteredSessions[0] && state.filteredSessions[0].title,
      statusBadge: document.querySelector("#status-badge").textContent,
      metricTotal: document.querySelector("#metric-total").textContent,
      metricStale: document.querySelector("#metric-stale").textContent,
      metricSize: document.querySelector("#metric-size").textContent,
      listRows: document.querySelectorAll("#session-list .session-item").length,
      pageIndicator: document.querySelector("#page-indicator").textContent,
      captions: document.querySelector("#list-caption").textContent,
    };
  });

  console.log("scan summary (" + (Date.now() - scanStarted) + "ms):", JSON.stringify(summary));
  equal("real sessions", summary.real, 12);
  equal("cache-only stale rows", summary.cacheOnly, 1);
  equal("orphan session dirs", summary.staleDirs, 1);
  equal("legacy flat files", summary.legacyFiles, 1);
  equal("empty project dirs", summary.emptyProjects, 1);
  equal("stale metric", summary.metricStale, "4");
  equal("page 1 row count", summary.listRows, 10);
  check("status badge connected", summary.statusBadge.includes("已连接") || summary.statusBadge.includes("Connected"), summary.statusBadge);
  check("title resolved", Boolean(summary.firstTitle) && summary.firstTitle.length > 0, String(summary.firstTitle));

  // ---- 详情 / 时间线 ----
  await page.click("#session-list .session-item:nth-child(1) .session-main");
  await page.waitForFunction(() => document.querySelectorAll("#detail-preview .conversation-item").length > 0, null, { timeout: 120000 });

  const detail = await page.evaluate(() => {
    const state = window.__dsh.state;
    const items = Array.from(document.querySelectorAll("#detail-preview .conversation-item"));
    const kinds = {};
    for (const item of items) {
      for (const kind of ["user", "assistant", "reasoning", "toolCall", "toolOutput", "system"]) {
        if (item.classList.contains(kind)) kinds[kind] = (kinds[kind] || 0) + 1;
      }
    }
    return {
      items: items.length,
      kinds,
      badge: document.querySelector("#detail-message-count").textContent,
      overview: document.querySelector("#detail-overview").textContent.replace(/\s+/g, " ").slice(0, 300),
      activeId: state.activeSessionId,
      logStats: state.filteredSessions.find((s) => s.id === state.activeSessionId)?.logStats || null,
    };
  });

  console.log("detail:", JSON.stringify(detail));
  check("timeline rendered", detail.items > 0, `${detail.items} items`);
  check("assistant blocks rendered", (detail.kinds.assistant || 0) > 0, JSON.stringify(detail.kinds));
  check("tool output hidden by default", !detail.kinds.system && !detail.kinds.reasoning, JSON.stringify(detail.kinds));
  check("overview shows log stats", Boolean(detail.logStats), JSON.stringify(detail.logStats && detail.logStats.records));

  // ---- 语块筛选: 先全选, 再单独查看工具调用 ----
  await page.click('#conversation-filter .conversation-filter-button[data-kind="all"]');
  await page.click('#conversation-filter .conversation-filter-button[data-kind="toolCall"]');
  await page.waitForFunction(() => {
    const items = document.querySelectorAll("#detail-preview .conversation-item");
    return items.length > 0 && Array.from(items).every((item) => item.classList.contains("toolCall"));
  }, null, { timeout: 60000 });
  const filtered = await page.evaluate(() => ({
    items: document.querySelectorAll("#detail-preview .conversation-item").length,
    badge: document.querySelector("#detail-message-count").textContent,
  }));
  check("toolCall filter isolates blocks", filtered.items > 0, JSON.stringify(filtered));

  await page.click('#conversation-filter .conversation-filter-button[data-kind="all"]');
  // ---- 元数据搜索 ----
  const activeId = await page.evaluate(() => window.__dsh.state.activeSessionId);
  await page.fill("#search-input", activeId);
  await page.waitForFunction(() => window.__dsh.state.filteredSessions.length === 1, null, { timeout: 30000 });
  equal("metadata search by id", await page.evaluate(() => window.__dsh.state.filteredSessions.length), 1);
  await page.fill("#search-input", "");
  await page.waitForFunction(() => window.__dsh.state.filteredSessions.length > 1, null, { timeout: 30000 });

  // ---- 正文搜索 ----
  const needle = await page.evaluate(() => {
    const state = window.__dsh.state;
    const session = state.filteredSessions.find((item) => item.id === state.activeSessionId);
    const entry = state.timelineCache.get(session.id);
    const item = entry && entry.items.find((block) => block.filterKind === "user" && block.body.length > 12);
    return item ? item.body.slice(0, 12) : null;
  });

  check("found needle for conversation search", Boolean(needle), String(needle));
  const filterIdBefore = await page.evaluate(() => window.__dsh.state.filterRequestId);
  await page.fill("#conversation-search-input", needle || "session");
  await page.waitForFunction((prev) => window.__dsh.state.filterRequestId > prev, filterIdBefore, { timeout: 60000 });
  await page.waitForFunction(() => !window.__dsh.state.decodeProgress, null, { timeout: 180000 });
  const searchState = await page.evaluate(() => ({
    filtered: window.__dsh.state.filteredSessions.length,
    badge: document.querySelector("#status-badge").textContent,
    highlighted: document.querySelectorAll("#detail-preview mark.search-highlight").length,
  }));
  check("conversation search matched", searchState.filtered >= 1, JSON.stringify(searchState));
  check("search highlight rendered", searchState.highlighted > 0, String(searchState.highlighted));
  await page.fill("#conversation-search-input", "");
  await page.waitForFunction(() => window.__dsh.state.filteredSessions.length > 1, null, { timeout: 60000 });

  // ---- 下载 ----
  await page.click("#session-list .session-item:nth-child(1) .session-main");
  await page.waitForFunction(() => document.querySelectorAll("#detail-preview .conversation-item").length > 0, null, { timeout: 120000 });

  const [jsonlDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#download-current-button"),
  ]);
  const jsonlPath = await jsonlDownload.path();
  const jsonlText = await readFile(jsonlPath, "utf8");
  check("JSONL download produced content", jsonlText.includes('"type":"session"'), `${jsonlText.length} chars, name=${jsonlDownload.suggestedFilename()}`);

  const [rawDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#download-raw-button"),
  ]);
  const rawPath = await rawDownload.path();
  const rawBytes = await readFile(rawPath);
  check(
    "raw download is zstd frame",
    rawBytes.length > 8 && rawBytes[0] === 0x28 && rawBytes[1] === 0xb5 && rawBytes[2] === 0x2f && rawBytes[3] === 0xfd,
    `${rawBytes.length} bytes, name=${rawDownload.suggestedFilename()}`,
  );

  // ---- 主题与语言 ----
  await page.click("#theme-toggle-button");
  equal("theme switched to dark", await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await page.click("#theme-toggle-button");
  equal("theme switched back to light", await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");

  await page.click("#locale-toggle-button");
  const englishTitle = await page.textContent("#hero-title");
  check("locale switched to English", englishTitle.includes("Local Session Manager"), englishTitle);
  await page.click("#locale-toggle-button");
  const chineseTitle = await page.textContent("#hero-title");
  check("locale switched back to Chinese", chineseTitle.includes("本地会话管理"), chineseTitle);

  // ---- 分页 ----
  await page.selectOption("#page-size-select", "50");
  await page.waitForFunction(() => document.querySelectorAll("#session-list .session-item").length > 10, null, { timeout: 30000 });
  const pageSizeRows = await page.evaluate(() => document.querySelectorAll("#session-list .session-item").length);
  check("page size change applies", pageSizeRows > 10, `${pageSizeRows} rows`);
  await page.selectOption("#page-size-select", "10");
  // ---- 删除当前会话 ----
  const beforeDelete = await page.evaluate(() => ({
    total: window.__dsh.state.sessions.length,
    real: window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length,
    id: window.__dsh.state.activeSessionId,
  }));

  await page.click("#delete-current-button");
  await page.waitForSelector("#confirm-modal:not([hidden])");
  await page.waitForFunction(() => !document.querySelector("#modal-confirm-button").disabled, null, { timeout: 15000 });
  await page.click("#modal-confirm-button");
  await page.waitForFunction(
    (expected) => window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length === expected,
    beforeDelete.real - 1,
    { timeout: 120000 },
  );

  const afterDelete = await page.evaluate(async (id) => {
    const rootHandle = await navigator.storage.getDirectory();
    const sessionsDir = await rootHandle.getDirectoryHandle("sessions");
    let found = false;

    for await (const project of sessionsDir.values()) {
      if (project.kind !== "directory") continue;
      for await (const entry of project.values()) {
        if (entry.name === id) found = true;
      }
    }

    return {
      real: window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length,
      stillOnDisk: found,
      cacheStillThere: window.__dsh.state.cacheIndex.has(id),
    };
  }, beforeDelete.id);

  check("session deleted from disk", !afterDelete.stillOnDisk, JSON.stringify(afterDelete));
  equal("session count decreased", afterDelete.real, beforeDelete.real - 1);

  // ---- 清理脏索引 ----
  const beforeCleanup = await page.evaluate(() => ({
    stale: window.__dsh.state.sessions.filter((s) => s.cacheOnly).length,
    staleDirs: window.__dsh.state.staleDirs.length,
    legacy: window.__dsh.state.legacyFiles.length,
    emptyProjects: window.__dsh.state.emptyProjects.length,
  }));

  await page.click("#cleanup-stale-button");
  await page.waitForSelector("#confirm-modal:not([hidden])");
  await page.waitForFunction(() => !document.querySelector("#modal-confirm-button").disabled, null, { timeout: 15000 });
  await page.click("#modal-confirm-button");
  await page.waitForFunction(() => window.__dsh.state.staleDirs.length === 0 && window.__dsh.state.legacyFiles.length === 0, null, { timeout: 120000 });

  const afterCleanup = await page.evaluate(async () => {
    const rootHandle = await navigator.storage.getDirectory();
    const sessionsDir = await rootHandle.getDirectoryHandle("sessions");
    const projects = [];

    for await (const project of sessionsDir.values()) {
      projects.push(project.name);
    }

    const cacheDir = await rootHandle.getDirectoryHandle("storages");
    const proj = await cacheDir.getDirectoryHandle("session_projcache");
    const sessions = await proj.getDirectoryHandle("sessions");
    const cacheFiles = [];

    for await (const entry of sessions.values()) cacheFiles.push(entry.name);

    return {
      cacheOnly: window.__dsh.state.sessions.filter((s) => s.cacheOnly).length,
      staleDirs: window.__dsh.state.staleDirs.length,
      legacy: window.__dsh.state.legacyFiles.length,
      emptyProjects: window.__dsh.state.emptyProjects.length,
      projects,
      staleCacheGone: !cacheFiles.some((name) => name.startsWith("deadbeef-")),
      metricStale: document.querySelector("#metric-stale").textContent,
    };
  });

  console.log("after cleanup:", JSON.stringify(afterCleanup));
  check("cleanup removed stale rows", afterCleanup.cacheOnly === 0, JSON.stringify(beforeCleanup));
  check("cleanup removed orphan dir / legacy file", afterCleanup.staleDirs === 0 && afterCleanup.legacy === 0);
  check("cleanup removed stale cache file", afterCleanup.staleCacheGone);
  check("cleanup removed empty + legacy project dirs", !afterCleanup.projects.includes("--Z-empty-project--") && !afterCleanup.projects.includes("--Z-legacy-project--"), afterCleanup.projects.join(","));

  // ---- 删除选中 ----
  await page.click("#session-list .session-item:nth-child(1) .session-checkbox");
  await page.click("#session-list .session-item:nth-child(2) .session-checkbox");
  await page.waitForFunction(() => window.__dsh.state.selectedIds.size === 2, null, { timeout: 30000 });
  const selectedBefore = await page.evaluate(() => window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length);
  await page.click("#delete-selected-button");
  await page.waitForSelector("#confirm-modal:not([hidden])");
  await page.waitForFunction(() => !document.querySelector("#modal-confirm-button").disabled, null, { timeout: 15000 });
  await page.click("#modal-confirm-button");
  await page.waitForFunction((expected) => window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length === expected, selectedBefore - 2, { timeout: 120000 });
  equal("delete selected removed 2 sessions", await page.evaluate(() => window.__dsh.state.sessions.filter((s) => !s.cacheOnly).length), selectedBefore - 2);

  // ---- 错误检查 ----
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 400));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(downloadDir, { recursive: true, force: true });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("failed checks:\n - " + failed.map((item) => item.name + " " + item.detail).join("\n - "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("E2E ERROR:", error);
  process.exitCode = 1;
});