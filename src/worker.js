/**
 * DSH 本地会话管理工具 - 解码工作线程
 *
 * 在 Worker 中完成 zstd 解压与 JSONL 解析, 避免阻塞主线程.
 * 本文件在构建时与 vendor/fzstd.min.js 拼接为一个经典 Worker 脚本,
 * 因此这里直接使用全局 self.fzstd.
 */

const ZSTD_MAGIC = 0xfd2fb528;
const PREFIX_BYTE_BUDGET = 256 * 1024;
const PREFIX_CHUNK_BYTES = 32 * 1024;
const TOOL_BODY_LIMIT = 3000;
const MINOR_BODY_LIMIT = 400;

const decoder = new TextDecoder("utf-8", { fatal: false });

self.onmessage = (event) => {
  const job = event.data || {};

  try {
    const result = handleJob(job);

    self.postMessage({ jobId: job.jobId, ok: true, result });
  } catch (error) {
    self.postMessage({
      jobId: job.jobId,
      ok: false,
      error: String((error && error.message) || error),
    });
  }
};

function handleJob(job) {
  const bytes = new Uint8Array(job.buffer);

  if (!looksLikeZstd(bytes)) {
    return readPlainJob(job, bytes);
  }

  if (job.cmd === "meta") {
    return readMetaJob(job, bytes);
  }

  return readTimelineJob(job, bytes);
}

function looksLikeZstd(bytes) {
  if (bytes.length < 4) {
    return false;
  }

  return (
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  );
}

function readPlainJob(job, bytes) {
  const text = decoder.decode(bytes);

  if (job.cmd === "meta") {
    return buildMeta(text, { complete: true });
  }

  const timeline = buildTimeline(text);

  if (job.options && job.options.wantText) {
    timeline.text = text;
  }

  return timeline;
}

function readMetaJob(job, bytes) {
  const text = decodePrefix(bytes, PREFIX_BYTE_BUDGET, hasMetaEvidence);
  const meta = buildMeta(text, { complete: false });
  const timeline = buildTimeline(text, { stopAfterUserMessage: true });
  const firstUser = timeline.items.find((item) => item.filterKind === "user");

  if (!meta.title && firstUser) {
    meta.title = firstLine(firstUser.body, 120);
  }

  if (!meta.promptSummary && firstUser) {
    meta.promptSummary = firstLine(firstUser.body, 200);
  }

  meta.userMessageCount = timeline.stats.userMessages;
  meta.lastTime = timeline.stats.lastTime;
  return meta;
}

function readTimelineJob(job, bytes) {
  const text = decoder.decode(decodeAll(bytes));
  const timeline = buildTimeline(text);

  if (job.options && job.options.wantText) {
    timeline.text = text;
  }

  return timeline;
}

function decodeAll(bytes) {
  return self.fzstd.decompress(bytes);
}

/**
 * 流式解压, 允许在满足条件后提前停止 (会话日志是首尾相接的多帧 zstd).
 */
function decodePrefix(bytes, budget, shouldStop) {
  let pushed = 0;
  let text = "";
  let stopped = false;

  const stream = new self.fzstd.Decompress((chunk) => {
    if (stopped) {
      return;
    }

    text += decoder.decode(chunk, { stream: true });

    if (shouldStop(text)) {
      stopped = true;
    }
  });

  while (pushed < bytes.length && pushed < budget && !stopped) {
    const end = Math.min(pushed + PREFIX_CHUNK_BYTES, bytes.length, budget);

    stream.push(bytes.subarray(pushed, end));
    pushed = end;
  }

  return text;
}

function hasMetaEvidence(text) {
  return text.includes('"type":"session/title"') && text.includes('"type":"user/message"');
}

function buildMeta(text, options) {
  const meta = {
    id: null,
    version: null,
    createdAt: null,
    cwd: null,
    agentPreset: null,
    title: null,
    promptSummary: null,
    lastTime: null,
    userMessageCount: 0,
    complete: Boolean(options && options.complete),
  };

  for (const record of iterateRecords(text)) {
    if (record.type === "session") {
      meta.id = typeof record.id === "string" ? record.id : meta.id;
      meta.version = typeof record.version === "number" ? record.version : meta.version;
      meta.createdAt = typeof record.createdAt === "number" ? record.createdAt : meta.createdAt;
      meta.cwd = typeof record.cwd === "string" ? record.cwd : meta.cwd;
      meta.agentPreset = typeof record.agentPreset === "string" ? record.agentPreset : meta.agentPreset;
      continue;
    }

    if (record.type === "session/title") {
      const title = record.data && record.data.title;

      if (typeof title === "string" && title.trim()) {
        meta.title = title.trim();
      }

      continue;
    }

    if (record.type === "user/message") {
      const data = record.data || {};

      if ((data.source || {}).kind !== "user") {
        continue;
      }

      if (!meta.promptSummary) {
        meta.promptSummary = firstLine(extractContentText(data.content), 200);
      }

      meta.userMessageCount += 1;
    }
  }

  return meta;
}

/**
 * 逐行解析 JSONL. 损坏行会被跳过, 保证单个坏行不中断整体解析.
 */
function* iterateRecords(text) {
  const lines = text.split("\n");
  const total = lines.length;

  for (let index = 0; index < total; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    // 提前停止时最后一行可能是不完整的 JSON, 直接跳过.
    if (index === total - 1 && !line.endsWith("}")) {
      continue;
    }

    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

function buildTimeline(text, options) {
  const stopAfterUserMessage = Boolean(options && options.stopAfterUserMessage);
  const items = [];
  const stats = {
    lines: 0,
    records: 0,
    corrupt: 0,
    events: 0,
    turns: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    createdAt: null,
    lastTime: null,
    truncatedItems: 0,
  };
  const callNames = new Map();
  const lines = text.split("\n");
  const total = lines.length;

  for (let index = 0; index < total; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    stats.lines += 1;

    if (index === total - 1 && !line.endsWith("}")) {
      // 提前停止产生的半行, 不计入损坏.
      stats.lines -= 1;
      continue;
    }

    let record;

    try {
      record = JSON.parse(line);
    } catch {
      stats.corrupt += 1;
      continue;
    }

    stats.records += 1;

    const type = record.type;
    const data = record.data || {};
    const time = typeof record.time === "number" ? record.time : null;

    if (time) {
      stats.lastTime = time;
    }

    if (type === "session") {
      stats.createdAt = typeof record.createdAt === "number" ? record.createdAt : stats.createdAt;
      continue;
    }

    stats.events += 1;

    if (type === "turn/start") {
      stats.turns += 1;
      continue;
    }

    if (type === "step/start") {
      stats.steps += 1;
      continue;
    }

    if (type === "user/message") {
      const body = extractContentText(data.content);
      const source = (data.source || {}).kind || "unknown";

      if (!body) {
        continue;
      }

      if (source === "user") {
        stats.userMessages += 1;
        pushItem(items, stats, { filterKind: "user", time, body });

        if (stopAfterUserMessage) {
          return { items, stats };
        }
      } else {
        pushItem(items, stats, {
          filterKind: "system",
          time,
          body,
          tag: source,
          minor: true,
          limit: MINOR_BODY_LIMIT,
        });
      }

      continue;
    }

    if (type === "assistant/message") {
      const content = (data.message || {}).content || [];
      let produced = false;

      for (const part of content) {
        if (!part || typeof part.text !== "string" || !part.text.trim()) {
          continue;
        }

        if (part.type === "reasoning") {
          pushItem(items, stats, { filterKind: "reasoning", time, body: part.text });
          produced = true;
        } else if (part.type === "text") {
          pushItem(items, stats, { filterKind: "assistant", time, body: part.text });
          produced = true;
        }
      }

      if (produced) {
        stats.assistantMessages += 1;
      }

      continue;
    }

    if (type === "tool/call") {
      const name = typeof data.name === "string" && data.name ? data.name : "tool";
      const callId = typeof data.callId === "string" ? data.callId : null;
      const args = typeof data.arguments === "string" ? data.arguments : safeStringify(data.arguments);

      if (callId) {
        callNames.set(callId, name);
      }

      stats.toolCalls += 1;
      pushItem(items, stats, {
        filterKind: "toolCall",
        time,
        body: args ? `${name}\n${args}` : name,
        name,
      });
      continue;
    }

    if (type === "tool/result") {
      const message = data.message || {};
      const body = extractContentText(message.content);
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : null;
      const name = callId && callNames.has(callId) ? callNames.get(callId) : null;
      const isError = Boolean(message.isError || data.error);

      if (!body && !isError) {
        continue;
      }

      stats.toolResults += 1;
      pushItem(items, stats, {
        filterKind: "toolOutput",
        time,
        body: body || "(no output)",
        name,
        error: isError,
      });
      continue;
    }

    if (type === "system/message") {
      const body = extractContentText((data.message || {}).content);

      if (body) {
        pushItem(items, stats, {
          filterKind: "system",
          time,
          body,
          tag: "system",
          minor: true,
        });
      }

      continue;
    }

    if (type === "compaction/summary") {
      const body = extractContentText(data.summary);

      if (body) {
        pushItem(items, stats, { filterKind: "system", time, body, tag: "compaction" });
      }

      continue;
    }

    if (type === "turn/end") {
      const kind = (data.reason || {}).kind;

      if (kind && kind !== "completed") {
        pushItem(items, stats, {
          filterKind: "system",
          time,
          body: `turn ${data.turn ?? "-"} · ${kind}`,
          tag: "turn",
          minor: true,
        });
      }
    }
  }

  return { items, stats };
}

function pushItem(items, stats, input) {
  const limit = input.limit || TOOL_BODY_LIMIT;
  const body = String(input.body || "").trim();

  if (!body) {
    return;
  }

  const truncated = body.length > limit;

  if (truncated) {
    stats.truncatedItems += 1;
  }

  items.push({
    filterKind: input.filterKind,
    time: input.time,
    body: truncated ? body.slice(0, limit) : body,
    bodyLength: body.length,
    truncated,
    name: input.name || null,
    tag: input.tag || null,
    minor: Boolean(input.minor),
    error: Boolean(input.error),
  });
}

function extractContentText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];

  for (const item of content) {
    if (!item) {
      continue;
    }

    if (typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }

    if (item.type === "file" && item.attachment) {
      const name = item.attachment.name || item.attachment.attachmentId || "attachment";
      const bytes = typeof item.attachment.bytes === "number" ? ` (${item.attachment.bytes} B)` : "";

      parts.push(`[附件] ${name}${bytes}`);
    }
  }

  return parts.join("\n\n").trim();
}

function firstLine(text, limit) {
  const value = String(text || "").trim();

  if (!value) {
    return "";
  }

  const line = value.split("\n")[0].trim() || value;
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
}

function safeStringify(value) {
  if (value === undefined || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// 供构建脚本做一致性校验: 与 fzstd 期望的帧魔数保持一致.
self.__DSH_WORKER_MAGIC__ = ZSTD_MAGIC;