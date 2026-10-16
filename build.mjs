/**
 * 构建脚本: 将样式 / 主程序 / 解码线程 / fzstd 内联进单个 HTML 文件.
 *
 *   node build.mjs
 *
 * 产物: dsh-session-manager.html (可直接双击用 Chrome / Edge 打开)
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outputPath = join(root, "dsh-session-manager.html");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

const styles = normalize(read("src/styles.css"));
const app = normalize(read("src/app.js"));
const worker = normalize(read("src/worker.js"));
const template = normalize(read("src/index.html"));
const fzstd = normalize(read("vendor/fzstd.min.js"));

const workerSource = [
  "/* fzstd - MIT License - Copyright (c) 2021 Arjun Barrett - https://github.com/101arrowz/fzstd */",
  fzstd,
  "",
  worker,
].join("\n");

for (const [name, text] of [["app", app], ["worker", workerSource], ["styles", styles]]) {
  if (text.includes("</script")) {
    throw new Error(`inline ${name} source contains "</script", refusing to build`);
  }
}

let html = template;

for (const [token, value] of [
  ["{{STYLES}}", styles],
  ["{{WORKER_JS}}", workerSource],
  ["{{APP_JS}}", app],
]) {
  if (!html.includes(token)) {
    throw new Error(`template token missing: ${token}`);
  }

  html = html.replace(token, () => value);
}

html = html.replace(/\n[ \t]+\n/g, "\n");

writeFileSync(outputPath, html, "utf8");

const size = statSync(outputPath).size;
console.log(`built ${outputPath} (${(size / 1024).toFixed(1)} KB)`);