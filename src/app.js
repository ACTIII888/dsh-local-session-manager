/**
 * DSH 本地会话管理工具 - 主程序
 *
 * 参考并移植自 Codex 本地会话管理工具
 * (https://github.com/zhengshukeji/codex-local-session-manager, Apache-2.0)
 * 的交互与结构, 针对 DeepSeek Harness (~/.dsh) 的会话存储格式实现:
 *   - 会话日志: <root>/sessions/<project>/<session-id>/session.v<N>.jsonl.zstd (多帧 zstd + JSONL)
 *   - 投影缓存: <root>/storages/session_projcache/sessions/<session-id>.json
 *   - 归档缓存: <root>/storages/session_projcache_archive_manager_v2/sessions/*.json
 *
 * 所有数据仅在浏览器本地处理, 不上传任何后端.
 */

const THEME_STORAGE_KEY = "dsh-session-console-theme";
const LOCALE_STORAGE_KEY = "dsh-session-console-locale";
const CONVERSATION_FILTER_KINDS = ["user", "assistant", "reasoning", "toolCall", "toolOutput", "system"];
const DEFAULT_VISIBLE_KINDS = ["user", "assistant", "toolCall", "toolOutput"];
const CONVERSATION_FILTERS = [
  { kind: "all", labelKey: "filter.all" },
  { kind: "user", labelKey: "timeline.user" },
  { kind: "assistant", labelKey: "timeline.assistant" },
  { kind: "reasoning", labelKey: "timeline.reasoning" },
  { kind: "toolCall", labelKey: "timeline.toolCall" },
  { kind: "toolOutput", labelKey: "timeline.toolOutput" },
  { kind: "system", labelKey: "timeline.system" },
];
const PROJCACHE_DOMAIN = "session_projcache";
const ARCHIVE_CACHE_DOMAIN = "session_projcache_archive_manager_v2";
const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl(\.zstd)?$/i;
const LEGACY_LOG_PATTERN = /\.jsonl(\.zstd)?$/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TIMELINE_CACHE_CHAR_LIMIT = 64 * 1024 * 1024;
const META_ENRICH_CONCURRENCY = 3;
const COUNTDOWN_SECONDS = 5;

const I18N = {
  "zh-CN": {
    meta: {
      title: "DeepSeek Harness 本地会话管理工具",
      heroTitle: "DeepSeek Harness 本地会话管理工具",
      heroDescription: "数据仅在浏览器本地处理, 不会发送到任何第三方或后端",
    },
    support: {
      unsupported: "请使用最新版 Chrome 或 Edge.",
    },
    section: {
      status: "状态",
      filter: "筛选",
      metrics: "统计",
      list: "会话列表",
      detail: "详情",
      conversation: "完整对话",
    },
    labels: {
      directory: "目录",
      scanned: "扫描",
      search: "标题 / 摘要 / ID",
      searchPlaceholder: "标题 / 摘要 / ID",
      conversationSearch: "用户 / 助手正文",
      conversationSearchPlaceholder: "用户 / 助手正文",
      age: "时间",
      exactDate: "精确日期",
      exactDatePlaceholder: "yyyy/mm/dd",
      sort: "排序",
      staleOnly: "只看脏索引",
      totalSessions: "会话总数",
      filteredResults: "筛选结果",
      totalSize: "总大小",
      staleIndexes: "脏索引",
      selected: "已选中",
      pageSize: "每页显示",
      sessionId: "会话 ID",
      fileSize: "文件大小",
      updatedAt: "最后更新",
      createdAt: "创建时间",
      status: "状态",
      project: "项目目录",
      model: "模型",
      permission: "权限",
      turns: "轮次 / 步骤",
      tokens: "令牌 (入 / 出)",
      events: "事件 / 异常行",
      logFile: "日志文件",
    },
    filter: {
      all: "全部",
      last7d: "近 7 天",
      last30d: "近 30 天",
      older: "30 天前",
      updatedDesc: "最近更新",
      sizeDesc: "文件大小",
      titleAsc: "标题 A-Z",
    },
    buttons: {
      pickDirectory: "选择目录",
      continuePickDirectory: "继续选择目录",
      reload: "重新扫描",
      deleteSelected: "删除选中",
      deleteAll: "删除全部",
      cleanupStale: "清理脏索引",
      selectPage: "全选当前页",
      unselectPage: "取消全选",
      prevPage: "上一页",
      nextPage: "下一页",
      download: "下载 JSONL",
      downloadRaw: "下载原始",
      deleteCurrent: "删除当前",
      delete: "删除",
      cancel: "取消",
      confirmDelete: "确认删除",
      confirmCleanup: "确认清理",
      localeIndicator: "EN",
    },
    badge: {
      disconnected: "未连接",
      connected: "已连接",
      loading: "扫描中",
      decoding: "解码中",
      error: "异常",
    },
    statusText: {
      unselectedDir: "未选择目录",
      connectedCount: "{{count}} 条会话",
      currentSession: "当前会话",
      decoding: "正在解码会话正文 {{done}} / {{total}}",
      enriching: "正在读取会话元数据 {{done}} / {{total}}",
    },
    list: {
      unscanned: "未扫描",
      noResults: "没有匹配的会话.",
      pageEmpty: "当前页没有内容.",
      zeroResults: "0 条结果",
      showing: "当前显示 {{start}}-{{end}} / {{total}} 条会话",
    },
    detail: {
      unselectedCaption: "未选择会话",
      noContent: "暂无会话内容.",
      noRenderableContent: "没有可展示的会话内容.",
      noFilteredContent: "没有匹配的语块.",
      loading: "加载中.",
      decoding: "正在解码会话日志...",
      statusNormal: "正常",
      statusStale: "脏索引",
      statusCorrupt: "含异常行",
      truncated: "已截断, 共 {{count}} 字符",
      errorItem: "调用失败",
      fullLogHint: "工具输出已按长度截断, 如需完整内容请使用「下载 JSONL」导出.",
    },
    modal: {
      titleAll: "确认删除全部会话",
      titleSingle: "确认删除当前会话",
      titleSelected: "确认删除选中会话",
      titleCleanupStale: "确认清理脏索引",
      titleDirectoryHelp: "请选择 .dsh 目录",
      subtitle: "危险操作",
      subtitleDirectoryHelp: "目录选择提示",
      summaryHead: "即将执行",
      summaryHeadDirectoryHelp: "常见路径",
      warningAll: "高风险: 该操作会移除当前目录下全部可删除的会话目录与对应投影缓存. 请先关闭 DeepSeek Harness, 再继续. 删除后无法恢复, 倒计时结束后才允许确认.",
      warningDelete: "高风险: 请先关闭 DeepSeek Harness, 再执行删除. 删除后无法恢复, 倒计时结束后才允许确认.",
      warningCleanupStale: "该操作会移除指向已消失会话的投影缓存文件, 没有会话日志的空目录, 以及会话目录外的遗留日志文件. 倒计时结束后才允许确认.",
      pathMacos: "macOS",
      pathWindows: "Windows",
      pathLinux: "Linux",
      pathMacosValue: "~/.dsh",
      pathWindowsValue: "%USERPROFILE%\\.dsh",
      pathLinuxValue: "~/.dsh",
      pathContains: "目录内应包含: sessions/, storages/",
      descAll: "即将删除 {{count}} 个会话, 共 {{size}}.",
      descSingle: "即将删除当前会话「{{title}}」, 共 {{size}}.",
      descSelected: "即将删除 {{count}} 个已选会话, 共 {{size}}.",
      descCleanupStale: "即将清理 {{count}} 条脏索引 / 空目录 / 遗留文件.",
      descDirectoryHelp: "继续后会打开系统目录选择器. 请选择包含 sessions 目录的 .dsh 根目录.",
      confirmCountdown: "{{seconds}}s 后可确认",
    },
    pagination: {
      page: "第 {{current}} / {{total}} 页",
      pageEmpty: "第 0 / 0 页",
    },
    timeline: {
      user: "用户",
      assistant: "助手",
      reasoning: "思考",
      toolCall: "工具调用",
      toolOutput: "工具输出",
      system: "系统",
      historyInput: "历史输入 #{{index}}",
      cacheSummary: "缓存摘要",
    },
    timelineTags: {
      user: "用户输入",
      "runtime-context": "运行时上下文",
      "skill-catalog": "技能目录",
      "tool-jobs": "工具任务",
      "user-approval": "用户审批",
      "model-selection": "模型选择",
      "agent-message": "子代理消息",
      "compact-checkpoint": "压缩检查点",
      "subagent-settled": "子代理完成",
      system: "系统提示",
      compaction: "压缩摘要",
      turn: "轮次",
      unknown: "注入内容",
    },
    summary: {
      staleMissing: "缓存存在, 会话日志已不存在.",
      none: "没有摘要.",
      empty: "空会话.",
    },
    locale: {
      switchTo: "切换到英文",
    },
    theme: {
      switchToLight: "切换到浅色模式",
      switchToDark: "切换到深色模式",
    },
    errors: {
      selectDshRoot: "请先选择包含 sessions 目录的 .dsh 文件夹.",
      missingSessions: "所选目录中没有找到 sessions 文件夹, 请选择 .dsh 根目录.",
      worker: "解码线程启动失败, 请改用最新版 Chrome 或 Edge.",
      unknown: "发生未知错误",
    },
  },  en: {
    meta: {
      title: "DeepSeek Harness Local Session Manager",
      heroTitle: "DeepSeek Harness Local Session Manager",
      heroDescription: "Data is processed locally in the browser and is not sent to any third party or backend.",
    },
    support: {
      unsupported: "Please use the latest Chrome or Edge.",
    },
    section: {
      status: "Status",
      filter: "Filters",
      metrics: "Stats",
      list: "Sessions",
      detail: "Details",
      conversation: "Conversation",
    },
    labels: {
      directory: "Directory",
      scanned: "Scanned",
      search: "Title / summary / ID",
      searchPlaceholder: "Title / summary / ID",
      conversationSearch: "User / assistant text",
      conversationSearchPlaceholder: "User / assistant text",
      age: "Age",
      exactDate: "Exact date",
      exactDatePlaceholder: "yyyy/mm/dd",
      sort: "Sort",
      staleOnly: "Stale only",
      totalSessions: "Sessions",
      filteredResults: "Filtered",
      totalSize: "Size",
      staleIndexes: "Stale",
      selected: "Selected",
      pageSize: "Per page",
      sessionId: "Session ID",
      fileSize: "File size",
      updatedAt: "Updated",
      createdAt: "Created",
      status: "Status",
      project: "Project",
      model: "Model",
      permission: "Permissions",
      turns: "Turns / steps",
      tokens: "Tokens (in / out)",
      events: "Events / corrupt",
      logFile: "Log file",
    },
    filter: {
      all: "All",
      last7d: "Last 7 days",
      last30d: "Last 30 days",
      older: "Older than 30 days",
      updatedDesc: "Recently updated",
      sizeDesc: "File size",
      titleAsc: "Title A-Z",
    },
    buttons: {
      pickDirectory: "Pick directory",
      continuePickDirectory: "Continue to picker",
      reload: "Rescan",
      deleteSelected: "Delete selected",
      deleteAll: "Delete all",
      cleanupStale: "Clean stale",
      selectPage: "Select page",
      unselectPage: "Unselect page",
      prevPage: "Prev",
      nextPage: "Next",
      download: "Download JSONL",
      downloadRaw: "Download raw",
      deleteCurrent: "Delete current",
      delete: "Delete",
      cancel: "Cancel",
      confirmDelete: "Confirm delete",
      confirmCleanup: "Confirm cleanup",
      localeIndicator: "中文",
    },
    badge: {
      disconnected: "Offline",
      connected: "Connected",
      loading: "Scanning",
      decoding: "Decoding",
      error: "Error",
    },
    statusText: {
      unselectedDir: "No directory selected",
      connectedCount: "{{count}} sessions",
      currentSession: "Current session",
      decoding: "Decoding conversation text {{done}} / {{total}}",
      enriching: "Reading session metadata {{done}} / {{total}}",
    },
    list: {
      unscanned: "Not scanned",
      noResults: "No matching sessions.",
      pageEmpty: "This page is empty.",
      zeroResults: "0 results",
      showing: "Showing {{start}}-{{end}} / {{total}} sessions",
    },
    detail: {
      unselectedCaption: "No session selected",
      noContent: "No session content yet.",
      noRenderableContent: "No renderable session content.",
      noFilteredContent: "No matching blocks.",
      loading: "Loading.",
      decoding: "Decoding session log...",
      statusNormal: "Normal",
      statusStale: "Stale index",
      statusCorrupt: "Corrupt lines",
      truncated: "Truncated, {{count}} chars total",
      errorItem: "Call failed",
      fullLogHint: "Tool output is truncated by length; use \"Download JSONL\" for the complete session.",
    },
    modal: {
      titleAll: "Delete all sessions",
      titleSingle: "Delete current session",
      titleSelected: "Delete selected sessions",
      titleCleanupStale: "Clean stale entries",
      titleDirectoryHelp: "Pick the .dsh directory",
      subtitle: "Dangerous operation",
      subtitleDirectoryHelp: "Directory hint",
      summaryHead: "About to run",
      summaryHeadDirectoryHelp: "Common paths",
      warningAll: "High risk: this removes every deletable session directory and its projection cache. Close DeepSeek Harness first. Deletion cannot be undone; confirmation unlocks after the countdown.",
      warningDelete: "High risk: close DeepSeek Harness before deleting. Deletion cannot be undone; confirmation unlocks after the countdown.",
      warningCleanupStale: "This removes projection cache files whose session is gone, empty session directories, and stray log files outside session directories. Confirmation unlocks after the countdown.",
      pathMacos: "macOS",
      pathWindows: "Windows",
      pathLinux: "Linux",
      pathMacosValue: "~/.dsh",
      pathWindowsValue: "%USERPROFILE%\\.dsh",
      pathLinuxValue: "~/.dsh",
      pathContains: "The directory should contain: sessions/, storages/",
      descAll: "About to delete {{count}} sessions, {{size}} in total.",
      descSingle: "About to delete session \"{{title}}\", {{size}} in total.",
      descSelected: "About to delete {{count}} selected sessions, {{size}} in total.",
      descCleanupStale: "About to clean {{count}} stale cache entries, empty directories or stray files.",
      descDirectoryHelp: "The system picker opens next. Choose the .dsh root that contains the sessions directory.",
      confirmCountdown: "Confirm in {{seconds}}s",
    },
    pagination: {
      page: "Page {{current}} / {{total}}",
      pageEmpty: "Page 0 / 0",
    },
    timeline: {
      user: "User",
      assistant: "Assistant",
      reasoning: "Reasoning",
      toolCall: "Tool call",
      toolOutput: "Tool output",
      system: "System",
      historyInput: "History input #{{index}}",
      cacheSummary: "Cached summary",
    },
    timelineTags: {
      user: "User input",
      "runtime-context": "Runtime context",
      "skill-catalog": "Skill catalog",
      "tool-jobs": "Tool jobs",
      "user-approval": "User approval",
      "model-selection": "Model selection",
      "agent-message": "Subagent message",
      "compact-checkpoint": "Compact checkpoint",
      "subagent-settled": "Subagent settled",
      system: "System prompt",
      compaction: "Compaction summary",
      turn: "Turn",
      unknown: "Injected content",
    },
    summary: {
      staleMissing: "Cache exists but the session log is gone.",
      none: "No summary.",
      empty: "Empty session.",
    },
    locale: {
      switchTo: "切换到中文",
    },
    theme: {
      switchToLight: "Switch to light mode",
      switchToDark: "Switch to dark mode",
    },
    errors: {
      selectDshRoot: "Pick the .dsh folder that contains the sessions directory.",
      missingSessions: "No sessions folder found in the selected directory. Pick the .dsh root.",
      worker: "Failed to start the decoder worker. Please use the latest Chrome or Edge.",
      unknown: "Unknown error",
    },
  },
};

const state = {
  rootHandle: null,
  sessionsDirHandle: null,
  storagesHandle: null,
  cacheIndex: new Map(),
  cacheHandles: {},
  sessions: [],
  filteredSessions: [],
  selectedIds: new Set(),
  conversationFilters: new Set(DEFAULT_VISIBLE_KINDS),
  activeSessionId: null,
  lastScannedAt: null,
  currentPage: 1,
  pageSize: 10,
  locale: "zh-CN",
  themeMode: "light",
  modalKind: null,
  pendingActionMode: null,
  countdownRemaining: 0,
  countdownTimer: null,
  timelineCache: new Map(),
  timelineCacheBytes: 0,
  previewRequestId: 0,
  filterRequestId: 0,
  filterDebounceTimer: null,
  scanToken: 0,
  worker: null,
  workerJobs: new Map(),
  jobSeq: 0,
  decodeProgress: null,
  enrichProgress: null,
};

const elements = {
  pickDirectoryButton: document.querySelector("#pick-directory-button"),
  reloadButton: document.querySelector("#reload-button"),
  deleteSelectedButton: document.querySelector("#delete-selected-button"),
  deleteAllButton: document.querySelector("#delete-all-button"),
  cleanupStaleButton: document.querySelector("#cleanup-stale-button"),
  searchInput: document.querySelector("#search-input"),
  conversationSearchInput: document.querySelector("#conversation-search-input"),
  ageFilter: document.querySelector("#age-filter"),
  exactDateInput: document.querySelector("#exact-date-input"),
  sortSelect: document.querySelector("#sort-select"),
  staleOnlyCheckbox: document.querySelector("#stale-only-checkbox"),
  selectPageButton: document.querySelector("#select-page-button"),
  pageSizeSelect: document.querySelector("#page-size-select"),
  prevPageButton: document.querySelector("#prev-page-button"),
  nextPageButton: document.querySelector("#next-page-button"),
  supportHint: document.querySelector("#support-hint"),
  statusBadge: document.querySelector("#status-badge"),
  statusText: document.querySelector("#status-text"),
  statusDirectory: document.querySelector("#status-directory"),
  statusScannedAt: document.querySelector("#status-scanned-at"),
  metricTotal: document.querySelector("#metric-total"),
  metricFiltered: document.querySelector("#metric-filtered"),
  metricSize: document.querySelector("#metric-size"),
  metricStale: document.querySelector("#metric-stale"),
  metricSelected: document.querySelector("#metric-selected"),
  listCaption: document.querySelector("#list-caption"),
  pageIndicator: document.querySelector("#page-indicator"),
  sessionList: document.querySelector("#session-list"),
  detailCaption: document.querySelector("#detail-caption"),
  detailOverview: document.querySelector("#detail-overview"),
  detailScroll: document.querySelector("#detail-scroll"),
  detailPreviewTitle: document.querySelector("#detail-preview-title"),
  conversationFilter: document.querySelector("#conversation-filter"),
  detailPreview: document.querySelector("#detail-preview"),
  detailMessageCount: document.querySelector("#detail-message-count"),
  downloadCurrentButton: document.querySelector("#download-current-button"),
  downloadRawButton: document.querySelector("#download-raw-button"),
  deleteCurrentButton: document.querySelector("#delete-current-button"),
  template: document.querySelector("#session-item-template"),
  localeToggleButton: document.querySelector("#locale-toggle-button"),
  themeToggleButton: document.querySelector("#theme-toggle-button"),
  modal: document.querySelector("#confirm-modal"),
  modalBackdrop: document.querySelector("#modal-backdrop"),
  modalIcon: document.querySelector("#modal-icon"),
  modalTitle: document.querySelector("#modal-title"),
  modalSubtitle: document.querySelector("#modal-subtitle"),
  modalSummaryHead: document.querySelector("#modal-summary-head"),
  modalDescription: document.querySelector("#modal-description"),
  modalWarning: document.querySelector("#modal-warning"),
  modalCancelButton: document.querySelector("#modal-cancel-button"),
  modalConfirmButton: document.querySelector("#modal-confirm-button"),
};

initialize();

function initialize() {
  const isSupported = "showDirectoryPicker" in window;

  elements.pickDirectoryButton.disabled = !isSupported;
  elements.supportHint.textContent = isSupported ? "" : t("support.unsupported");
  elements.pageSizeSelect.value = String(state.pageSize);
  elements.reloadButton.disabled = true;

  renderConversationFilters();

  elements.pickDirectoryButton.addEventListener("click", openDirectoryHelpDialog);
  elements.reloadButton.addEventListener("click", () => scanSessions().catch(handleError));
  elements.deleteSelectedButton.addEventListener("click", () => openConfirmDialog("selected"));
  elements.deleteAllButton.addEventListener("click", () => openConfirmDialog("all"));
  elements.cleanupStaleButton.addEventListener("click", () => openConfirmDialog("stale"));
  elements.searchInput.addEventListener("input", handleFilterChange);
  elements.conversationSearchInput.addEventListener("input", handleFilterChange);
  elements.ageFilter.addEventListener("change", handleFilterChange);
  elements.exactDateInput.addEventListener("input", handleExactDateInput);
  elements.sortSelect.addEventListener("change", handleFilterChange);
  elements.staleOnlyCheckbox.addEventListener("change", handleFilterChange);
  elements.selectPageButton.addEventListener("click", handleSelectCurrentPage);
  elements.pageSizeSelect.addEventListener("change", handlePageSizeChange);
  elements.prevPageButton.addEventListener("click", () => changePage(-1));
  elements.nextPageButton.addEventListener("click", () => changePage(1));
  elements.downloadCurrentButton.addEventListener("click", () => downloadCurrentSession().catch(handleError));
  elements.downloadRawButton.addEventListener("click", () => downloadRawCurrentSession().catch(handleError));
  elements.deleteCurrentButton.addEventListener("click", () => openConfirmDialog("single"));
  elements.modalBackdrop.addEventListener("click", handleModalDismiss);
  elements.modalCancelButton.addEventListener("click", handleModalDismiss);
  elements.modalConfirmButton.addEventListener("click", () => handleModalConfirm().catch(handleError));
  elements.localeToggleButton.addEventListener("click", cycleLocale);
  elements.themeToggleButton.addEventListener("click", cycleTheme);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden) {
      handleModalDismiss();
    }
  });

  applyLocale(getInitialLocale());
  applyTheme(getInitialThemeMode());
  renderEmptyList(t("list.unscanned"));
  renderDetails(null);
  updateStatus();
}

/* ------------------------------------------------------------------ 目录选择 */

async function pickDirectoryFromSystem() {
  let picked;

  try {
    picked = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error && error.name === "AbortError") {
      return;
    }

    throw error;
  }

  const sessionsDir = await getOptionalDirectory(picked, ["sessions"]);
  let rootHandle = picked;
  let sessionsHandle = sessionsDir;

  if (!sessionsHandle) {
    // 允许直接选择 sessions 目录: 此时无法读取 storages 投影缓存.
    if (!(await looksLikeSessionsDirectory(picked))) {
      throw new Error(t("errors.missingSessions"));
    }

    rootHandle = picked;
    sessionsHandle = picked;
  }

  state.rootHandle = rootHandle;
  state.sessionsDirHandle = sessionsHandle;
  state.storagesHandle = sessionsDir ? await getOptionalDirectory(picked, ["storages"]) : null;
  state.cacheHandles = {};
  elements.reloadButton.disabled = false;
  await scanSessions();
}

async function looksLikeSessionsDirectory(handle) {
  let directories = 0;

  try {
    for await (const entry of handle.values()) {
      if (entry.kind !== "directory") {
        return false;
      }

      directories += 1;

      if (directories > 3) {
        break;
      }
    }
  } catch {
    return false;
  }

  return directories > 0;
}

async function getOptionalDirectory(parentHandle, path) {
  if (!parentHandle) {
    return null;
  }

  let current = parentHandle;

  for (const segment of path) {
    try {
      current = await current.getDirectoryHandle(segment);
    } catch (error) {
      if (error && error.name === "NotFoundError") {
        return null;
      }

      throw error;
    }
  }

  return current;
}

/* ------------------------------------------------------------------ 扫描 */

async function scanSessions() {
  ensureRootSelected();

  const token = ++state.scanToken;
  const startedAt = Date.now();

  setLoadingState(t("badge.loading"));

  const [tree, cacheIndex] = await Promise.all([
    readSessionTree(state.sessionsDirHandle, token),
    readCacheIndex(token),
  ]);

  if (token !== state.scanToken) {
    return;
  }

  state.cacheIndex = cacheIndex;
  state.timelineCache.clear();
  state.timelineCacheBytes = 0;

  const sessions = tree.sessions.map((session) => applyCacheMetadata(session, cacheIndex));
  const knownIds = new Set(sessions.map((session) => session.id));
  const pendingMeta = sessions.filter((session) => !session.title || !session.cwd || !session.createdAt);

  if (pendingMeta.length) {
    await enrichSessionMetadata(pendingMeta, token);
  }

  if (token !== state.scanToken) {
    return;
  }

  for (const session of sessions) {
    session.title = session.title || session.logTitle || truncateText(session.summary || "", 80) || session.id;
    session.summary = session.summary || session.logSummary || "";
    session.updatedAt = session.updatedAt || session.lastModified || session.createdAt || null;
  }

  const staleRows = [];

  for (const [id, bucket] of cacheIndex.entries()) {
    if (knownIds.has(id)) {
      continue;
    }

    const meta = (bucket.proj && bucket.proj.meta) || (bucket.archive[0] && bucket.archive[0].meta) || null;

    staleRows.push({
      id,
      stale: true,
      cacheOnly: true,
      title: (meta && meta.title) || id,
      summary: (meta && meta.prompt) || "",
      updatedAt: (meta && meta.lastPromptAt) || null,
      createdAt: (meta && meta.createdAt) || null,
      cwd: (meta && meta.cwd) || "",
      size: 0,
      lastModified: null,
      model: (meta && meta.model) || null,
      stats: (meta && meta.stats) || null,
      tokens: (meta && meta.tokens) || null,
      bucket,
    });
  }

  state.sessions = [...sessions, ...staleRows];
  state.staleDirs = tree.staleDirs;
  state.legacyFiles = tree.legacyFiles;
  state.emptyProjects = tree.emptyProjects;
  state.lastScannedAt = new Date();
  state.currentPage = 1;
  state.enrichProgress = null;

  pruneSelection();

  if (!state.activeSessionId || !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0] ? state.sessions[0].id : null;
  }

  console.info("[dsh] scanned " + state.sessions.length + " sessions in " + (Date.now() - startedAt) + "ms");
  await applyFilters();
}

async function readSessionTree(root, token) {
  const sessions = [];
  const staleDirs = [];
  const legacyFiles = [];
  const emptyProjects = [];

  for await (const project of root.values()) {
    if (token !== state.scanToken) {
      return { sessions, staleDirs, legacyFiles, emptyProjects };
    }

    if (project.kind !== "directory") {
      continue;
    }

    let directoryCount = 0;
    let entryCount = 0;

    for await (const entry of project.values()) {
      entryCount += 1;

      if (entry.kind === "directory") {
        directoryCount += 1;

        const log = await findLatestLog(entry);

        if (!log) {
          staleDirs.push({
            kind: "dir",
            name: entry.name,
            parentHandle: project,
            projectName: project.name,
          });
          continue;
        }

        const file = await log.handle.getFile();

        sessions.push({
          id: decodePathSegment(entry.name),
          dirName: entry.name,
          projectName: project.name,
          projectPath: decodeProjectDirName(project.name),
          dirHandle: entry,
          projectHandle: project,
          logHandle: log.handle,
          logName: log.name,
          logVersion: log.version,
          compressed: log.compressed,
          size: file.size,
          lastModified: file.lastModified || null,
          stale: false,
          cacheOnly: false,
        });

        continue;
      }

      if (LEGACY_LOG_PATTERN.test(entry.name)) {
        legacyFiles.push({
          kind: "legacy",
          name: entry.name,
          parentHandle: project,
          projectName: project.name,
          projectHandle: project,
        });
      }
    }

    if (!entryCount) {
      emptyProjects.push({ kind: "project", name: project.name, handle: project });
    }
  }

  return { sessions, staleDirs, legacyFiles, emptyProjects };
}

async function findLatestLog(directoryHandle) {
  let best = null;

  for await (const entry of directoryHandle.values()) {
    if (entry.kind !== "file") {
      continue;
    }

    const match = entry.name.match(SESSION_LOG_PATTERN);

    if (!match) {
      continue;
    }

    const version = Number(match[1]) || 0;

    if (!best || version > best.version) {
      best = {
        handle: entry,
        name: entry.name,
        version,
        compressed: entry.name.toLowerCase().endsWith(".zstd"),
      };
    }
  }

  return best;
}

async function readCacheIndex(token) {
  const index = new Map();
  const projDir = await getCacheDirectoryHandle(PROJCACHE_DOMAIN);

  if (projDir) {
    for await (const entry of projDir.values()) {
      if (token !== state.scanToken) {
        return index;
      }

      if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }

      const id = entry.name.slice(0, -5);
      const record = await readCacheRecord(entry);
      const bucket = index.get(id) || { id, proj: null, archive: [] };

      bucket.proj = { handle: entry, name: entry.name, meta: extractCacheMeta(record) };
      index.set(id, bucket);
    }
  }

  const archiveDir = await getCacheDirectoryHandle(ARCHIVE_CACHE_DOMAIN);

  if (archiveDir) {
    for await (const entry of archiveDir.values()) {
      if (token !== state.scanToken) {
        return index;
      }

      if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }

      const record = await readCacheRecord(entry);
      const id = record && record.sessionId;

      if (typeof id !== "string" || !id) {
        continue;
      }

      const bucket = index.get(id) || { id, proj: null, archive: [] };

      bucket.archive.push({ handle: entry, name: entry.name, meta: extractCacheMeta(record) });
      index.set(id, bucket);
    }
  }

  return index;
}

async function getCacheDirectoryHandle(domain) {
  if (domain in state.cacheHandles) {
    return state.cacheHandles[domain];
  }

  const handle = await getOptionalDirectory(state.storagesHandle, [domain, "sessions"]);

  state.cacheHandles[domain] = handle;
  return handle;
}

async function readCacheRecord(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);

    return parsed && parsed.record ? parsed.record : null;
  } catch (error) {
    console.warn("[dsh] failed to read projection cache", fileHandle.name, error);
    return null;
  }
}

function extractCacheMeta(record) {
  if (!record) {
    return null;
  }

  const rows = record.rows || {};
  const identity = record.identity || {};
  const titleValue = rows.title && rows.title.val;
  const outline = rows.turnOutline && rows.turnOutline.val;
  const turns = outline && Array.isArray(outline.turns) ? outline.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const listMeta = (rows.sessionListMetadata && rows.sessionListMetadata.val) || null;

  return {
    formatVersion: identity.formatVersion === undefined ? null : identity.formatVersion,
    createdAt: typeof identity.createdAt === "number" ? identity.createdAt : null,
    cwd: typeof identity.cwd === "string" ? identity.cwd : null,
    title: typeof titleValue === "string" ? titleValue.trim() : (titleValue && titleValue.title) || null,
    prompt: lastTurn && typeof lastTurn.prompt === "string" ? lastTurn.prompt.trim() : null,
    response: lastTurn && typeof lastTurn.response === "string" ? lastTurn.response.trim() : null,
    lastPromptAt: listMeta && typeof listMeta.lastPromptAt === "number" ? listMeta.lastPromptAt : null,
    blank: listMeta ? Boolean(listMeta.blank) : null,
    model: (rows.modelSelection && rows.modelSelection.val && rows.modelSelection.val.lastUsed) || null,
    agentPreset: (rows.agentPreset && rows.agentPreset.val) || null,
    sandboxMode: (rows.sandboxMode && rows.sandboxMode.val) || null,
    permissions: (rows.permissions && rows.permissions.val && rows.permissions.val.preset) || null,
    stats: (rows.sessionStats && rows.sessionStats.val) || null,
    tokens: (rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals) || null,
  };
}

function applyCacheMetadata(session, cacheIndex) {
  const bucket = cacheIndex.get(session.id) || null;
  const meta = (bucket && ((bucket.proj && bucket.proj.meta) || (bucket.archive[0] && bucket.archive[0].meta))) || null;

  session.bucket = bucket;
  session.cacheMeta = meta;
  session.createdAt = (meta && meta.createdAt) || null;
  session.cwd = (meta && meta.cwd) || session.projectPath;
  session.title = (meta && meta.title) || null;
  session.summary = (meta && meta.prompt) || null;
  session.response = (meta && meta.response) || null;
  session.model = (meta && meta.model) || null;
  session.stats = (meta && meta.stats) || null;
  session.tokens = (meta && meta.tokens) || null;
  session.permissions = (meta && meta.permissions) || null;
  session.sandboxMode = (meta && meta.sandboxMode) || null;
  session.agentPreset = (meta && meta.agentPreset) || null;
  session.blank = meta ? meta.blank : null;

  const candidates = [session.lastModified, meta && meta.lastPromptAt].filter(
    (value) => typeof value === "number" && value > 0,
  );

  session.updatedAt = candidates.length ? Math.max.apply(null, candidates) : null;
  return session;
}

async function enrichSessionMetadata(sessions, token) {
  const queue = sessions.slice();
  let done = 0;

  state.enrichProgress = { done, total: sessions.length };
  updateStatus();

  const worker = async () => {
    while (queue.length) {
      if (token !== state.scanToken) {
        return;
      }

      const session = queue.shift();
      const meta = await readSessionMeta(session).catch((error) => {
        console.warn("[dsh] meta read failed", session.id, error);
        return null;
      });

      if (meta) {
        session.logTitle = meta.title || null;
        session.logSummary = meta.promptSummary || null;
        session.cwd = session.cwd || meta.cwd || session.projectPath;
        session.createdAt = session.createdAt || meta.createdAt || null;
        session.logVersion = meta.version === undefined ? session.logVersion : meta.version;
        session.logUserMessages = meta.userMessageCount;
      }

      done += 1;
      state.enrichProgress = { done, total: sessions.length };
      updateStatus();
    }
  };

  await Promise.all(Array.from({ length: META_ENRICH_CONCURRENCY }, worker));
}

function readSessionMeta(session) {
  return runWorkerJob("meta", session.logHandle);
}

/* ------------------------------------------------------------------ Worker */

function getWorker() {
  if (state.worker) {
    return state.worker;
  }

  const source = document.querySelector("#dsh-worker-source").textContent;
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", (event) => {
    console.error("[dsh] worker error", event.message || event);
    rejectAllJobs(new Error(t("errors.worker")));
  });

  state.worker = worker;
  return worker;
}

function rejectAllJobs(error) {
  for (const job of state.workerJobs.values()) {
    job.reject(error);
  }

  state.workerJobs.clear();
}

function handleWorkerMessage(event) {
  const data = event.data || {};
  const job = state.workerJobs.get(data.jobId);

  if (!job) {
    return;
  }

  state.workerJobs.delete(data.jobId);

  if (data.ok) {
    job.resolve(data.result);
  } else {
    job.reject(new Error(data.error || t("errors.unknown")));
  }
}

async function runWorkerJob(cmd, fileHandle, options) {
  const worker = getWorker();
  const jobId = ++state.jobSeq;
  const file = await fileHandle.getFile();
  const buffer = await file.arrayBuffer();

  return new Promise((resolve, reject) => {
    state.workerJobs.set(jobId, { resolve, reject });
    worker.postMessage({ jobId, cmd, buffer, options: options || null }, [buffer]);
  });
}

/* ------------------------------------------------------------------ 筛选 */

function handleFilterChange() {
  state.currentPage = 1;
  scheduleApplyFilters();
}

function handleExactDateInput(event) {
  const formatted = formatExactDateInput(event.target.value);

  if (event.target.value !== formatted) {
    event.target.value = formatted;
  }

  handleFilterChange();
}

function handlePageSizeChange() {
  state.pageSize = Number(elements.pageSizeSelect.value) || 10;
  state.currentPage = 1;
  renderList();
  renderDetails(getActiveSession());
  updateStatus();
}

function changePage(offset) {
  const totalPages = getTotalPages();
  const nextPage = Math.min(Math.max(state.currentPage + offset, 1), Math.max(totalPages, 1));

  if (nextPage === state.currentPage) {
    return;
  }

  state.currentPage = nextPage;
  renderList();
  updateStatus();
}

function scheduleApplyFilters() {
  if (state.filterDebounceTimer) {
    window.clearTimeout(state.filterDebounceTimer);
  }

  state.filterDebounceTimer = window.setTimeout(() => {
    state.filterDebounceTimer = null;
    applyFilters().catch(handleError);
  }, 160);
}

async function applyFilters() {
  const requestId = ++state.filterRequestId;
  const metadataQuery = getMetadataSearchQuery().toLowerCase();
  const conversationQuery = getConversationSearchQuery().toLowerCase();
  const age = elements.ageFilter.value;
  const exactDate = parseExactDateFilter(elements.exactDateInput.value);
  const sort = elements.sortSelect.value;
  const staleOnly = elements.staleOnlyCheckbox.checked;
  const now = Date.now();
  const candidates = [];

  for (const session of state.sessions) {
    if (staleOnly && !session.stale) {
      continue;
    }

    if (metadataQuery) {
      const modelName = session.model && session.model.model ? session.model.model : "";
      const haystack = [session.title, session.id, session.summary, session.cwd, modelName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(metadataQuery)) {
        continue;
      }
    }

    if (exactDate.status === "invalid") {
      continue;
    }

    if (exactDate.status === "ready" && getSessionDateKey(session) !== exactDate.key) {
      continue;
    }

    if (age !== "all") {
      const updatedTime = toTimestamp(session.updatedAt || session.lastModified);

      if (!updatedTime) {
        if (age !== "older") {
          continue;
        }
      } else {
        const diff = now - updatedTime;

        if (age === "7d" && diff > 7 * 24 * 60 * 60 * 1000) {
          continue;
        }

        if (age === "30d" && diff > 30 * 24 * 60 * 60 * 1000) {
          continue;
        }

        if (age === "older" && diff <= 30 * 24 * 60 * 60 * 1000) {
          continue;
        }
      }
    }

    candidates.push(session);
  }

  let filteredSessions = candidates;

  if (conversationQuery) {
    filteredSessions = [];
    state.decodeProgress = { done: 0, total: candidates.length };
    updateStatus();

    for (const session of candidates) {
      if (requestId !== state.filterRequestId) {
        state.decodeProgress = null;
        return;
      }

      let matched = false;

      try {
        matched = await sessionMatchesConversationQuery(session, conversationQuery);
      } catch (error) {
        console.warn("[dsh] conversation search failed", session.id, error);
      }

      state.decodeProgress = { done: state.decodeProgress.done + 1, total: candidates.length };

      if (matched) {
        filteredSessions.push(session);
      }
    }

    state.decodeProgress = null;
  }

  if (requestId !== state.filterRequestId) {
    return;
  }

  state.filteredSessions = filteredSessions;

  state.filteredSessions.sort((left, right) => {
    if (sort === "size-desc") {
      return right.size - left.size;
    }

    if (sort === "title-asc") {
      return String(left.title || "").localeCompare(String(right.title || ""), state.locale === "zh-CN" ? "zh-CN" : "en");
    }

    return toTimestamp(right.updatedAt || right.lastModified) - toTimestamp(left.updatedAt || left.lastModified);
  });

  const totalPages = getTotalPages();
  state.currentPage = totalPages ? Math.min(state.currentPage, totalPages) : 1;

  if (!state.filteredSessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.filteredSessions[0] ? state.filteredSessions[0].id : null;
  }

  renderList();
  renderDetails(getActiveSession());
  updateStatus();
}

async function sessionMatchesConversationQuery(session, query) {
  const entry = await getSessionTimeline(session);

  return entry.items.some((item) => {
    if (item.filterKind !== "user" && item.filterKind !== "assistant") {
      return false;
    }

    return String(item.body || "").toLowerCase().includes(query);
  });
}

/* ------------------------------------------------------------------ 列表渲染 */

function renderList() {
  elements.sessionList.innerHTML = "";

  const sessionsOnPage = getPagedSessions();

  if (!sessionsOnPage.length) {
    renderEmptyList(state.filteredSessions.length ? t("list.pageEmpty") : t("list.noResults"));
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const session of sessionsOnPage) {
    const node = createListItemNode();
    const checkbox = node.querySelector(".session-checkbox");
    const button = node.querySelector(".session-main");
    const title = node.querySelector(".session-title");
    const size = node.querySelector(".session-size");
    const id = node.querySelector(".session-id");
    const updated = node.querySelector(".session-updated");
    const summary = node.querySelector(".session-summary");

    title.innerHTML = highlightSearchText(
      session.stale ? session.title + " · " + t("detail.statusStale") : session.title,
      getMetadataSearchQuery(),
    );
    size.textContent = formatBytes(session.size);
    id.innerHTML = highlightSearchText(abbreviateId(session.id), getMetadataSearchQuery());
    updated.textContent = formatDateTime(session.updatedAt || session.lastModified);
    summary.innerHTML = highlightSearchText(buildSessionSummary(session), getMetadataSearchQuery());
    checkbox.checked = state.selectedIds.has(session.id);
    checkbox.disabled = !isSessionDeletable(session);

    if (session.id === state.activeSessionId) {
      node.classList.add("is-active");
    }

    checkbox.addEventListener("change", (event) => {
      toggleSelection(session.id, event.target.checked);
    });

    button.addEventListener("click", () => {
      state.activeSessionId = session.id;
      renderList();
      renderDetails(session);
      updateStatus();
    });

    fragment.appendChild(node);
  }

  elements.sessionList.appendChild(fragment);
}

function createListItemNode() {
  return elements.template.content.firstElementChild.cloneNode(true);
}

function renderDetails(session) {
  state.previewRequestId += 1;

  if (!session) {
    elements.detailCaption.textContent = t("detail.unselectedCaption");
    elements.detailOverview.innerHTML = [
      makeOverviewItem(t("labels.sessionId"), "-"),
      makeOverviewItem(t("labels.project"), "-"),
      makeOverviewItem(t("labels.fileSize"), "-"),
      makeOverviewItem(t("labels.updatedAt"), "-"),
      makeOverviewItem(t("labels.status"), "-"),
    ].join("");
    elements.detailPreviewTitle.textContent = t("section.conversation");
    setBadgeText(elements.detailMessageCount, "0");
    elements.detailPreview.innerHTML = "<p class=\"empty-state\">" + escapeHtml(t("detail.noContent")) + "</p>";
    elements.downloadCurrentButton.disabled = true;
    elements.downloadCurrentButton.textContent = t("buttons.download");
    elements.downloadRawButton.disabled = true;
    elements.downloadRawButton.textContent = t("buttons.downloadRaw");
    elements.deleteCurrentButton.disabled = true;
    elements.deleteCurrentButton.textContent = t("buttons.delete");
    return;
  }

  elements.detailCaption.textContent = session.cacheOnly
    ? (session.projectName || "-") + " · " + t("detail.statusStale")
    : (session.projectName || "-") + " · " + (session.dirName || "-");
  elements.detailOverview.innerHTML = buildOverviewItems(session).join("");
  elements.detailPreviewTitle.textContent = t("section.conversation");
  elements.downloadCurrentButton.disabled = !isSessionDownloadable(session);
  elements.downloadCurrentButton.textContent = t("buttons.download");
  elements.downloadRawButton.disabled = !isSessionDownloadable(session);
  elements.downloadRawButton.textContent = t("buttons.downloadRaw");
  elements.deleteCurrentButton.disabled = !isSessionDeletable(session);
  elements.deleteCurrentButton.textContent = t("buttons.delete");

  if (elements.detailScroll) {
    elements.detailScroll.scrollTop = 0;
  }

  renderTimeline(session).catch(handleError);
}

function buildOverviewItems(session) {
  const items = [
    makeOverviewItem(t("labels.sessionId"), session.id),
    makeOverviewItem(t("labels.project"), session.cwd || session.projectPath || "-"),
    makeOverviewItem(t("labels.fileSize"), session.cacheOnly ? "-" : formatBytes(session.size)),
    makeOverviewItem(t("labels.createdAt"), formatDateTime(session.createdAt)),
    makeOverviewItem(t("labels.updatedAt"), formatDateTime(session.updatedAt || session.lastModified)),
    makeOverviewItem(t("labels.status"), getSessionStatusLabel(session)),
  ];

  const model = session.model;

  if (model && (model.provider || model.model)) {
    items.push(makeOverviewItem(t("labels.model"), [model.provider, model.model].filter(Boolean).join(" / ")));
  }

  const permission = [session.agentPreset, session.permissions || session.sandboxMode].filter(Boolean).join(" · ");

  if (permission) {
    items.push(makeOverviewItem(t("labels.permission"), permission));
  }

  if (session.stats && (session.stats.turns || session.stats.steps)) {
    const turns = session.stats.turns === undefined ? "-" : session.stats.turns;
    const steps = session.stats.steps === undefined ? "-" : session.stats.steps;

    items.push(makeOverviewItem(t("labels.turns"), turns + " / " + steps));
  }

  if (session.tokens) {
    const input = (session.tokens.uncachedInputTokens || 0) + (session.tokens.cacheReadTokens || 0);
    const output = session.tokens.outputTokens || 0;

    items.push(makeOverviewItem(t("labels.tokens"), formatCount(input) + " / " + formatCount(output)));
  }

  if (session.logStats) {
    items.push(
      makeOverviewItem(
        t("labels.events"),
        formatCount(session.logStats.records) + " / " + formatCount(session.logStats.corrupt),
      ),
    );
  }

  if (session.logName) {
    items.push(makeOverviewItem(t("labels.logFile"), session.logName));
  }

  return items;
}

function getSessionStatusLabel(session) {
  if (session.stale) {
    return t("detail.statusStale");
  }

  if (session.logStats && session.logStats.corrupt) {
    return t("detail.statusCorrupt");
  }

  return t("detail.statusNormal");
}

function buildSessionSummary(session) {
  if (session.summary) {
    return session.summary;
  }

  if (session.cacheOnly) {
    return t("summary.staleMissing");
  }

  if (session.blank) {
    return t("summary.empty");
  }

  return session.dirName || t("summary.none");
}

/* ------------------------------------------------------------------ 详情 / 时间线 */

async function renderTimeline(session) {
  const requestId = ++state.previewRequestId;

  if (session.cacheOnly || !session.logHandle) {
    const fallback = buildFallbackTimeline(session);
    setBadgeText(elements.detailMessageCount, String(fallback.length));
    elements.detailPreview.innerHTML = fallback.length
      ? fallback.map(renderConversationItem).join("")
      : "<p class=\"empty-state\">" + escapeHtml(t("detail.noRenderableContent")) + "</p>";
    return;
  }

  const cached = state.timelineCache.get(session.id);

  if (!cached) {
    elements.detailPreview.innerHTML = "<p class=\"empty-state\">" + escapeHtml(t("detail.decoding")) + "</p>";
  }

  const entry = await getSessionTimeline(session);

  if (requestId !== state.previewRequestId) {
    return;
  }

  const visibleTimeline = filterConversationTimeline(entry.items);

  elements.detailOverview.innerHTML = buildOverviewItems(session).join("");
  setBadgeText(elements.detailMessageCount, visibleTimeline.length + "/" + entry.items.length);

  if (!entry.items.length) {
    elements.detailPreview.innerHTML = "<p class=\"empty-state\">" + escapeHtml(t("detail.noRenderableContent")) + "</p>";
    return;
  }

  if (!visibleTimeline.length) {
    elements.detailPreview.innerHTML = "<p class=\"empty-state\">" + escapeHtml(t("detail.noFilteredContent")) + "</p>";
    return;
  }

  const html = visibleTimeline.map(renderConversationItem).join("");
  const hint = entry.stats && entry.stats.truncatedItems
    ? "<p class=\"conversation-hint\">" + escapeHtml(t("detail.fullLogHint")) + "</p>"
    : "";

  elements.detailPreview.innerHTML = html + hint;
}

async function getSessionTimeline(session) {
  if (session.cacheOnly || !session.logHandle) {
    return { items: buildFallbackTimeline(session), stats: null };
  }

  const cached = state.timelineCache.get(session.id);

  if (cached) {
    touchTimeline(session.id, cached);
    return cached;
  }

  const result = await runWorkerJob("timeline", session.logHandle);
  const entry = { items: result.items, stats: result.stats, size: estimateTimelineSize(result.items) };

  session.logStats = result.stats;
  cacheTimeline(session.id, entry);
  return entry;
}

function estimateTimelineSize(items) {
  let size = 0;

  for (const item of items) {
    size += (item.body || "").length + 64;
  }

  return size;
}

function cacheTimeline(id, entry) {
  state.timelineCache.set(id, entry);
  state.timelineCacheBytes += entry.size;
  evictTimelines();
}

function touchTimeline(id, entry) {
  state.timelineCache.delete(id);
  state.timelineCache.set(id, entry);
}

function evictTimelines() {
  while (state.timelineCacheBytes > TIMELINE_CACHE_CHAR_LIMIT && state.timelineCache.size > 1) {
    const oldestId = state.timelineCache.keys().next().value;
    const entry = state.timelineCache.get(oldestId);

    state.timelineCache.delete(oldestId);
    state.timelineCacheBytes -= entry ? entry.size : 0;
  }
}

function buildFallbackTimeline(session) {
  const texts = [session.summary, session.response].filter(Boolean);

  if (session.cacheOnly && !texts.length) {
    return [];
  }

  return texts.map((text, index) => ({
    filterKind: "user",
    time: session.updatedAt || null,
    body: text,
    bodyLength: text.length,
    truncated: false,
    name: null,
    tag: index === 0 ? "cache" : "response",
    minor: false,
    error: false,
  }));
}

function renderConversationFilters() {
  if (!elements.conversationFilter) {
    return;
  }

  elements.conversationFilter.innerHTML = CONVERSATION_FILTERS.map((filter) => {
    const active = isConversationFilterActive(filter.kind);

    return "<button class=\"conversation-filter-button" + (active ? " is-active" : "") +
      "\" type=\"button\" data-kind=\"" + escapeHtml(filter.kind) + "\" aria-pressed=\"" + (active ? "true" : "false") +
      "\">" + escapeHtml(t(filter.labelKey)) + "</button>";
  }).join("");

  for (const button of elements.conversationFilter.querySelectorAll(".conversation-filter-button")) {
    button.addEventListener("click", () => {
      toggleConversationFilter(button.dataset.kind);
    });
  }
}

function isConversationFilterActive(kind) {
  if (kind === "all") {
    return state.conversationFilters.size === CONVERSATION_FILTER_KINDS.length;
  }

  return state.conversationFilters.has(kind);
}

function toggleConversationFilter(kind) {
  if (kind === "all") {
    state.conversationFilters = new Set(CONVERSATION_FILTER_KINDS);
  } else if (state.conversationFilters.size === CONVERSATION_FILTER_KINDS.length && CONVERSATION_FILTER_KINDS.includes(kind)) {
    state.conversationFilters = new Set([kind]);
  } else if (state.conversationFilters.has(kind)) {
    state.conversationFilters.delete(kind);
  } else if (CONVERSATION_FILTER_KINDS.includes(kind)) {
    state.conversationFilters.add(kind);
  }

  if (!state.conversationFilters.size) {
    state.conversationFilters = new Set(DEFAULT_VISIBLE_KINDS);
  }

  renderConversationFilters();
  renderDetails(getActiveSession());
}

function filterConversationTimeline(timeline) {
  if (state.conversationFilters.size === CONVERSATION_FILTER_KINDS.length) {
    return timeline;
  }

  return timeline.filter((item) => state.conversationFilters.has(item.filterKind));
}

function renderConversationItem(item) {
  const roleLabel = t("timeline." + item.filterKind);
  const query = shouldHighlightConversationItem(item) ? getConversationSearchQuery() : "";
  const tags = [];

  if (item.tag) {
    const tagLabel = t("timelineTags." + item.tag);
    const resolved = tagLabel === "timelineTags." + item.tag ? item.tag : tagLabel;

    tags.push("<span class=\"conversation-tag\">" + escapeHtml(resolved) + "</span>");
  }

  if (item.name) {
    tags.push("<span class=\"conversation-tag\">" + escapeHtml(item.name) + "</span>");
  }

  if (item.error) {
    tags.push("<span class=\"conversation-tag is-error\">" + escapeHtml(t("detail.errorItem")) + "</span>");
  }

  if (item.truncated) {
    tags.push(
      "<span class=\"conversation-tag is-muted\">" +
        escapeHtml(t("detail.truncated", { count: formatCount(item.bodyLength) })) +
        "</span>",
    );
  }

  return "<article class=\"conversation-item " + escapeHtml(item.filterKind) + (item.minor ? " is-minor" : "") + "\">" +
    "<div class=\"conversation-meta\">" +
      "<span class=\"conversation-role\">" + escapeHtml(roleLabel) + "</span>" +
      "<span class=\"conversation-tags\">" + tags.join("") + "</span>" +
      "<span class=\"conversation-time\">" + escapeHtml(formatDateTime(item.time)) + "</span>" +
    "</div>" +
    "<div class=\"conversation-body\">" + highlightSearchText(item.body, query) + "</div>" +
  "</article>";
}

function shouldHighlightConversationItem(item) {
  return item.filterKind === "user" || item.filterKind === "assistant";
}

/* ------------------------------------------------------------------ 下载 */

async function downloadCurrentSession() {
  const session = getActiveSession();

  if (!session || !isSessionDownloadable(session)) {
    return;
  }

  elements.downloadCurrentButton.disabled = true;

  try {
    const text = await readSessionText(session);
    const blob = new Blob([text], { type: "application/x-ndjson" });

    triggerDownload(blob, session.id + ".jsonl");
  } finally {
    elements.downloadCurrentButton.disabled = !isSessionDownloadable(session);
  }
}

async function readSessionText(session) {
  const result = await runWorkerJob("timeline", session.logHandle, { wantText: true });
  const entry = { items: result.items, stats: result.stats, size: estimateTimelineSize(result.items) };

  session.logStats = result.stats;
  cacheTimeline(session.id, entry);
  return result.text || "";
}

async function downloadRawCurrentSession() {
  const session = getActiveSession();

  if (!session || !isSessionDownloadable(session)) {
    return;
  }

  const file = await session.logHandle.getFile();

  triggerDownload(file, session.logName || session.id + ".jsonl.zstd");
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/* ------------------------------------------------------------------ 状态 */

function updateStatus() {
  const staleCount = getStaleTargets().length;
  const totalSize = state.sessions.reduce((sum, session) => sum + (session.size || 0), 0);
  const totalPages = getTotalPages();
  const deletableCount = state.sessions.filter(isSessionDeletable).length;
  const startIndex = state.filteredSessions.length ? (state.currentPage - 1) * state.pageSize + 1 : 0;
  const endIndex = Math.min(state.currentPage * state.pageSize, state.filteredSessions.length);

  setText(elements.metricTotal, state.sessions.length ? String(state.sessions.length) : "-");
  setText(elements.metricFiltered, state.sessions.length ? String(state.filteredSessions.length) : "-");
  setText(elements.metricSize, state.sessions.length ? formatBytes(totalSize) : "-");
  setText(elements.metricStale, String(staleCount));
  setText(elements.metricSelected, String(state.selectedIds.size));
  elements.statusDirectory.textContent = state.rootHandle ? state.rootHandle.name : "-";
  elements.statusScannedAt.textContent = state.lastScannedAt ? formatDateTime(state.lastScannedAt.toISOString()) : "-";

  if (state.decodeProgress || state.enrichProgress) {
    const progress = state.decodeProgress || state.enrichProgress;

    elements.statusBadge.textContent = state.decodeProgress ? t("badge.decoding") : t("badge.loading");
    setBadgeTone(elements.statusBadge, "info");
    elements.statusText.textContent = t(state.decodeProgress ? "statusText.decoding" : "statusText.enriching", {
      done: progress.done,
      total: progress.total,
    });
  } else {
    elements.statusBadge.textContent = state.rootHandle ? t("badge.connected") : t("badge.disconnected");
    setBadgeTone(elements.statusBadge, state.rootHandle ? "success" : "neutral");
    elements.statusText.textContent = state.rootHandle
      ? t("statusText.connectedCount", { count: state.sessions.length })
      : t("statusText.unselectedDir");
  }

  if (!state.filteredSessions.length) {
    elements.listCaption.textContent = state.rootHandle ? t("list.zeroResults") : t("list.unscanned");
  } else {
    elements.listCaption.textContent = t("list.showing", {
      start: startIndex,
      end: endIndex,
      total: state.filteredSessions.length,
    });
  }

  elements.pageIndicator.textContent = totalPages
    ? t("pagination.page", { current: state.currentPage, total: totalPages })
    : t("pagination.pageEmpty");
  elements.prevPageButton.disabled = state.currentPage <= 1;
  elements.nextPageButton.disabled = !totalPages || state.currentPage >= totalPages;
  elements.deleteSelectedButton.disabled = !state.selectedIds.size;
  elements.deleteSelectedButton.hidden = !state.selectedIds.size;
  elements.deleteAllButton.disabled = !deletableCount;
  elements.cleanupStaleButton.disabled = !staleCount;
  elements.selectPageButton.disabled = !getPagedSelectableSessions().length;
  elements.selectPageButton.textContent = areAllPagedSessionsSelected()
    ? t("buttons.unselectPage")
    : t("buttons.selectPage");
}

function renderEmptyList(text) {
  elements.sessionList.innerHTML = "<p class=\"empty-state\">" + escapeHtml(text) + "</p>";
}

function setLoadingState(text) {
  elements.statusBadge.textContent = text;
  setBadgeTone(elements.statusBadge, "info");
  elements.statusText.textContent = text;
  renderEmptyList(t("list.unscanned"));
}

function toggleSelection(id, checked) {
  if (checked) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }

  updateStatus();
}

function handleSelectCurrentPage() {
  const pageSessions = getPagedSelectableSessions();
  const shouldSelect = !areAllPagedSessionsSelected();

  for (const session of pageSessions) {
    if (shouldSelect) {
      state.selectedIds.add(session.id);
    } else {
      state.selectedIds.delete(session.id);
    }
  }

  renderList();
  updateStatus();
}

/* ------------------------------------------------------------------ 弹窗 */

function openDirectoryHelpDialog() {
  state.modalKind = "directory-help";
  state.pendingActionMode = null;
  state.countdownRemaining = 0;
  elements.modal.hidden = false;
  refreshModalDialog();
  clearCountdown();
  elements.modalConfirmButton.disabled = false;
}

function openConfirmDialog(mode) {
  const targets = getActionTargets(mode);

  if (!targets.length) {
    return;
  }

  state.modalKind = "action";
  state.pendingActionMode = mode;
  elements.modal.hidden = false;
  refreshModalDialog();

  resetCountdown(COUNTDOWN_SECONDS);
}

function refreshModalDialog() {
  if (state.modalKind === "directory-help") {
    refreshDirectoryHelpDialog();
    return;
  }

  refreshDeleteDialogText();
}

function refreshDeleteDialogText() {
  const targets = getActionTargets(state.pendingActionMode);

  elements.modal.dataset.variant = "danger";
  elements.modalIcon.innerHTML = getModalIconMarkup("action");
  elements.modalTitle.textContent = getDialogTitle(state.pendingActionMode);
  elements.modalSubtitle.textContent = t("modal.subtitle");
  elements.modalSummaryHead.textContent = t("modal.summaryHead");
  elements.modalDescription.textContent = getDialogDescription(state.pendingActionMode, targets);
  elements.modalWarning.textContent = getDialogWarning(state.pendingActionMode);
  elements.modalCancelButton.textContent = t("buttons.cancel");
  elements.modalConfirmButton.className = "danger-button small";
  elements.modalConfirmButton.textContent = getConfirmActionText(state.pendingActionMode);
}

function refreshDirectoryHelpDialog() {
  elements.modal.dataset.variant = "info";
  elements.modalIcon.innerHTML = getModalIconMarkup("directory-help");
  elements.modalTitle.textContent = t("modal.titleDirectoryHelp");
  elements.modalSubtitle.textContent = t("modal.subtitleDirectoryHelp");
  elements.modalSummaryHead.textContent = t("modal.summaryHeadDirectoryHelp");
  elements.modalDescription.textContent = t("modal.descDirectoryHelp");
  elements.modalWarning.innerHTML = getDirectoryHelpMarkup();
  elements.modalCancelButton.textContent = t("buttons.cancel");
  elements.modalConfirmButton.className = "primary-button";
  elements.modalConfirmButton.textContent = t("buttons.continuePickDirectory");
}

function closeModalDialog() {
  clearCountdown();
  state.countdownRemaining = 0;
  elements.modal.hidden = true;
  elements.modal.dataset.variant = "danger";
  elements.modalIcon.innerHTML = getModalIconMarkup("action");
  elements.modalDescription.textContent = "";
  elements.modalWarning.textContent = "";
  elements.modalCancelButton.textContent = t("buttons.cancel");
  elements.modalConfirmButton.className = "danger-button small";
  state.pendingActionMode = null;
  state.modalKind = null;
  elements.modalConfirmButton.disabled = true;
  elements.modalConfirmButton.textContent = t("buttons.confirmDelete");
}

function resetCountdown(seconds) {
  clearCountdown();
  state.countdownRemaining = seconds;
  refreshCountdownButton();

  if (!seconds) {
    elements.modalConfirmButton.disabled = false;
    return;
  }

  elements.modalConfirmButton.disabled = true;
  state.countdownTimer = window.setInterval(() => {
    state.countdownRemaining -= 1;
    refreshCountdownButton();

    if (state.countdownRemaining <= 0) {
      clearCountdown();
      elements.modalConfirmButton.disabled = false;
      elements.modalConfirmButton.textContent = getConfirmActionText(state.pendingActionMode);
    }
  }, 1000);
}

function refreshCountdownButton() {
  if (state.countdownRemaining > 0) {
    elements.modalConfirmButton.textContent = t("modal.confirmCountdown", { seconds: state.countdownRemaining });
    return;
  }

  elements.modalConfirmButton.textContent = getConfirmActionText(state.pendingActionMode);
}

function clearCountdown() {
  if (state.countdownTimer) {
    window.clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function handleModalDismiss() {
  closeModalDialog();
}

async function handleModalConfirm() {
  if (state.modalKind === "directory-help") {
    closeModalDialog();
    await pickDirectoryFromSystem();
    return;
  }

  await confirmPendingAction();
}

async function confirmPendingAction() {
  const mode = state.pendingActionMode;
  const targets = getActionTargets(mode);

  if (!targets.length) {
    closeModalDialog();
    return;
  }

  elements.modalConfirmButton.disabled = true;

  let failure = null;

  try {
    if (mode === "stale") {
      await cleanupStaleEntries(targets);
    } else {
      await deleteSessions(targets);
    }
  } catch (error) {
    failure = error;
    console.error("[dsh] action failed", error);
  } finally {
    closeModalDialog();
  }

  await scanSessions();

  if (failure) {
    elements.statusBadge.textContent = t("badge.error");
    setBadgeTone(elements.statusBadge, "danger");
    elements.statusText.textContent = (failure && failure.message) || t("errors.unknown");
  }
}

async function deleteSessions(sessions) {
  for (const session of sessions) {
    if (!session.dirHandle || !session.projectHandle) {
      continue;
    }

    await session.projectHandle.removeEntry(session.dirName, { recursive: true });
    state.selectedIds.delete(session.id);
    state.timelineCache.delete(session.id);

    await removeCacheEntries(session);
  }
}

async function removeCacheEntries(session) {
  const bucket = session.bucket || state.cacheIndex.get(session.id);

  if (!bucket) {
    return;
  }

  const projDir = await getCacheDirectoryHandle(PROJCACHE_DOMAIN);
  const archiveDir = await getCacheDirectoryHandle(ARCHIVE_CACHE_DOMAIN);

  if (bucket.proj && bucket.proj.handle) {
    await removeEntrySafe(projDir, bucket.proj.name);
  }

  for (const entry of bucket.archive || []) {
    await removeEntrySafe(archiveDir, entry.name);
  }
}

async function removeEntrySafe(directoryHandle, name, recursive = false) {
  if (!directoryHandle || !name) {
    return;
  }

  try {
    await directoryHandle.removeEntry(name, recursive ? { recursive: true } : undefined);
  } catch (error) {
    if (error && error.name === "NotFoundError") {
      return;
    }

    throw error;
  }
}

async function cleanupStaleEntries(targets) {
  const projDir = await getCacheDirectoryHandle(PROJCACHE_DOMAIN);
  const archiveDir = await getCacheDirectoryHandle(ARCHIVE_CACHE_DOMAIN);

  for (const target of targets) {
    if (target.kind === "cache") {
      if (target.bucket.proj && target.bucket.proj.handle) {
        await removeEntrySafe(projDir, target.bucket.proj.name);
      }

      for (const entry of target.bucket.archive || []) {
        await removeEntrySafe(archiveDir, entry.name);
      }

      continue;
    }

    if (target.kind === "dir") {
      await removeEntrySafe(target.projectHandle || state.sessionsDirHandle, target.name, true);

      if (target.projectHandle) {
        await removeEmptyProjectDir(target.projectHandle);
      }

      continue;
    }

    if (target.kind === "legacy") {
      await removeEntrySafe(target.parentHandle || state.sessionsDirHandle, target.name);

      if (target.projectHandle) {
        await removeEmptyProjectDir(target.projectHandle);
      }

      continue;
    }

    if (target.kind === "project") {
      await removeEntrySafe(target.parentHandle || state.sessionsDirHandle, target.name, true);
    }
  }
}

async function removeEmptyProjectDir(projectHandle) {
  try {
    for await (const entry of projectHandle.values()) {
      void entry;
      return;
    }
  } catch {
    return;
  }

  await removeEntrySafe(state.sessionsDirHandle, projectHandle.name, true);
}

function getActionTargets(mode) {
  if (mode === "stale") {
    return getStaleTargets();
  }

  if (mode === "single") {
    const active = getActiveSession();
    return active && isSessionDeletable(active) ? [active] : [];
  }

  if (mode === "all") {
    return state.sessions.filter(isSessionDeletable);
  }

  return state.sessions.filter((session) => state.selectedIds.has(session.id) && isSessionDeletable(session));
}

function getStaleTargets() {
  const targets = [];

  for (const session of state.sessions) {
    if (session.cacheOnly) {
      targets.push({ kind: "cache", bucket: session.bucket, session });
    }
  }

  for (const dir of state.staleDirs || []) {
    targets.push({ kind: "dir", name: dir.name, projectHandle: dir.parentHandle || state.sessionsDirHandle, size: 0 });
  }

  for (const file of state.legacyFiles || []) {
    targets.push({
      kind: "legacy",
      name: file.name,
      parentHandle: file.parentHandle || state.sessionsDirHandle,
      projectHandle: file.projectHandle,
      size: 0,
    });
  }

  for (const project of state.emptyProjects || []) {
    targets.push({ kind: "project", name: project.name, parentHandle: state.sessionsDirHandle, size: 0 });
  }

  return targets;
}

function getDialogTitle(mode) {
  if (mode === "stale") {
    return t("modal.titleCleanupStale");
  }

  if (mode === "all") {
    return t("modal.titleAll");
  }

  if (mode === "single") {
    return t("modal.titleSingle");
  }

  return t("modal.titleSelected");
}

function getDialogDescription(mode, targets) {
  if (mode === "stale") {
    return t("modal.descCleanupStale", { count: targets.length });
  }

  if (mode === "all") {
    return t("modal.descAll", { count: targets.length, size: formatBytes(sumSizes(targets)) });
  }

  if (mode === "single") {
    const active = getActiveSession();

    return t("modal.descSingle", {
      title: (active && active.title) || "-",
      size: formatBytes(sumSizes(targets)),
    });
  }

  return t("modal.descSelected", { count: targets.length, size: formatBytes(sumSizes(targets)) });
}

function getDialogWarning(mode) {
  if (mode === "stale") {
    return t("modal.warningCleanupStale");
  }

  return mode === "all" ? t("modal.warningAll") : t("modal.warningDelete");
}

function getConfirmActionText(mode) {
  return mode === "stale" ? t("buttons.confirmCleanup") : t("buttons.confirmDelete");
}

function getModalIconMarkup(kind) {
  if (kind === "directory-help") {
    return "<svg viewBox=\"0 0 24 24\"><path d=\"M9.6 9.3a2.4 2.4 0 1 1 4.15 1.65c-.73.72-1.75 1.28-1.75 2.55v.5\"></path><path d=\"M12 16.5v.01\"></path><circle cx=\"12\" cy=\"12\" r=\"9\"></circle></svg>";
  }

  return "<svg viewBox=\"0 0 24 24\"><path d=\"M12 8v5\"></path><path d=\"M12 16.5h.01\"></path><path d=\"M10.3 3.8 2.9 17a2 2 0 0 0 1.8 3h14.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z\"></path></svg>";
}

function getDirectoryHelpMarkup() {
  const items = [
    { label: t("modal.pathMacos"), value: t("modal.pathMacosValue") },
    { label: t("modal.pathWindows"), value: t("modal.pathWindowsValue") },
    { label: t("modal.pathLinux"), value: t("modal.pathLinuxValue") },
  ];

  const cards = items.map((item) =>
    "<article class=\"modal-path-item\"><div class=\"modal-path-title\">" + escapeHtml(item.label) +
    "</div><div class=\"modal-path-value\">" + escapeHtml(item.value) + "</div></article>"
  ).join("");

  return "<div class=\"modal-path-grid\">" + cards + "</div><p class=\"modal-directory-footnote\">" +
    escapeHtml(t("modal.pathContains")) + "</p>";
}

/* ------------------------------------------------------------------ 分页与选中 */

function getActiveSession() {
  return state.filteredSessions.find((session) => session.id === state.activeSessionId) || null;
}

function getPagedSessions() {
  if (!state.filteredSessions.length) {
    return [];
  }

  const start = (state.currentPage - 1) * state.pageSize;
  return state.filteredSessions.slice(start, start + state.pageSize);
}

function getPagedSelectableSessions() {
  return getPagedSessions().filter(isSessionDeletable);
}

function areAllPagedSessionsSelected() {
  const selectable = getPagedSelectableSessions();

  return Boolean(selectable.length) && selectable.every((session) => state.selectedIds.has(session.id));
}

function getTotalPages() {
  return Math.ceil(state.filteredSessions.length / state.pageSize);
}

function pruneSelection() {
  const validIds = new Set(state.sessions.filter(isSessionDeletable).map((session) => session.id));

  for (const id of Array.from(state.selectedIds)) {
    if (!validIds.has(id)) {
      state.selectedIds.delete(id);
    }
  }
}

/* ------------------------------------------------------------------ 语言与主题 */

function applyLocale(locale) {
  state.locale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.setAttribute("lang", locale === "zh-CN" ? "zh-CN" : "en");
  document.title = t("meta.title");
  elements.localeToggleButton.textContent = t("buttons.localeIndicator");
  elements.localeToggleButton.setAttribute("aria-label", t("locale.switchTo"));
  elements.localeToggleButton.setAttribute("title", t("locale.switchTo"));

  const textMap = [
    ["#hero-title", "meta.heroTitle"],
    ["#hero-description", "meta.heroDescription"],
    ["#status-title", "section.status"],
    ["#filter-title", "section.filter"],
    ["#metrics-title", "section.metrics"],
    ["#list-title", "section.list"],
    ["#detail-section-title", "section.detail"],
    ["#detail-preview-title", "section.conversation"],
    ["#status-directory-label", "labels.directory"],
    ["#status-scanned-label", "labels.scanned"],
    ["#metadata-search-label", "labels.search"],
    ["#conversation-search-label", "labels.conversationSearch"],
    ["#age-filter-label", "labels.age"],
    ["#exact-date-label", "labels.exactDate"],
    ["#sort-label", "labels.sort"],
    ["#stale-only-label", "labels.staleOnly"],
    ["#metric-total-label", "labels.totalSessions"],
    ["#metric-filtered-label", "labels.filteredResults"],
    ["#metric-size-label", "labels.totalSize"],
    ["#metric-stale-label", "labels.staleIndexes"],
    ["#metric-selected-label", "labels.selected"],
    ["#page-size-label", "labels.pageSize"],
  ];

  for (const entry of textMap) {
    const node = document.querySelector(entry[0]);

    if (node) {
      node.textContent = t(entry[1]);
    }
  }

  elements.searchInput.placeholder = t("labels.searchPlaceholder");
  elements.conversationSearchInput.placeholder = t("labels.conversationSearchPlaceholder");
  elements.exactDateInput.placeholder = t("labels.exactDatePlaceholder");
  elements.pickDirectoryButton.textContent = t("buttons.pickDirectory");
  elements.reloadButton.textContent = t("buttons.reload");
  elements.deleteAllButton.textContent = t("buttons.deleteAll");
  elements.cleanupStaleButton.textContent = t("buttons.cleanupStale");
  elements.deleteSelectedButton.textContent = t("buttons.deleteSelected");
  elements.ageFilter.options[0].textContent = t("filter.all");
  elements.ageFilter.options[1].textContent = t("filter.last7d");
  elements.ageFilter.options[2].textContent = t("filter.last30d");
  elements.ageFilter.options[3].textContent = t("filter.older");
  elements.sortSelect.options[0].textContent = t("filter.updatedDesc");
  elements.sortSelect.options[1].textContent = t("filter.sizeDesc");
  elements.sortSelect.options[2].textContent = t("filter.titleAsc");

  if (state.sessions.length) {
    renderList();
    renderDetails(getActiveSession());
  }

  renderConversationFilters();
  applyTheme(state.themeMode);
  updateStatus();
}

function cycleLocale() {
  applyLocale(state.locale === "zh-CN" ? "en" : "zh-CN");
}

function getInitialLocale() {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);

  if (saved === "zh-CN" || saved === "en") {
    return saved;
  }

  return navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function applyTheme(mode) {
  state.themeMode = mode;
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  elements.themeToggleButton.classList.toggle("is-active", mode === "dark");
  elements.themeToggleButton.innerHTML = "<span class=\"theme-icon\" aria-hidden=\"true\">" + getThemeIcon() + "</span>";
  elements.themeToggleButton.setAttribute("aria-label", getThemeToggleLabel(mode));
  elements.themeToggleButton.setAttribute("title", getThemeToggleLabel(mode));
}

function cycleTheme() {
  applyTheme(state.themeMode === "dark" ? "light" : "dark");
}

function getInitialThemeMode() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);

  if (saved === "light" || saved === "dark") {
    return saved;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getThemeToggleLabel(mode) {
  return mode === "dark" ? t("theme.switchToLight") : t("theme.switchToDark");
}

function getThemeIcon() {
  return "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">" +
    "<circle cx=\"12\" cy=\"12\" r=\"4.2\"></circle>" +
    "<path d=\"M12 2.5v2.6\"></path><path d=\"M12 18.9v2.6\"></path>" +
    "<path d=\"M21.5 12h-2.6\"></path><path d=\"M5.1 12H2.5\"></path>" +
    "<path d=\"M18.7 5.3l-1.8 1.8\"></path><path d=\"M7.1 16.9l-1.8 1.8\"></path>" +
    "<path d=\"M18.7 18.7l-1.8-1.8\"></path><path d=\"M7.1 7.1L5.3 5.3\"></path></svg>";
}

/* ------------------------------------------------------------------ 工具函数 */

function t(key, params = {}) {
  const localeTable = I18N[state.locale] || I18N["zh-CN"];
  const fallbackTable = I18N["zh-CN"];
  const resolved = resolveMessage(localeTable, key);
  const template = resolved === undefined ? resolveMessage(fallbackTable, key) : resolved;

  return String(template === undefined ? key : template).replace(/\{\{(\w+)\}\}/g, (_, token) => String(params[token] === undefined ? "" : params[token]));
}

function resolveMessage(table, key) {
  return key.split(".").reduce((current, segment) => (current === undefined || current === null ? undefined : current[segment]), table);
}

function ensureRootSelected() {
  if (!state.rootHandle || !state.sessionsDirHandle) {
    throw new Error(t("errors.selectDshRoot"));
  }
}

function decodePathSegment(name) {
  return String(name).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeProjectDirName(name) {
  const trimmed = String(name);

  if (trimmed.startsWith("--") && trimmed.endsWith("--") && trimmed.length > 4) {
    return decodePathSegment(trimmed.slice(2, -2));
  }

  return decodePathSegment(trimmed);
}

function isSessionDeletable(session) {
  return !session.stale && Boolean(session.projectHandle && session.dirName);
}

function isSessionDownloadable(session) {
  return !session.stale && Boolean(session.logHandle);
}

function truncateText(text, limit) {
  const value = String(text || "");

  if (value.length <= limit) {
    return value;
  }

  return value.slice(0, limit) + "...";
}

function abbreviateId(id) {
  const value = String(id || "");

  return value.length > 18 ? value.slice(0, 8) + "..." + value.slice(-4) : value;
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? 0 : parsed;
}

function sumSizes(items) {
  return items.reduce((sum, item) => sum + (item.size || 0), 0);
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return value.toFixed(value >= 10 || index === 0 ? 0 : 1) + " " + units[index];
}

function formatCount(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  if (value < 1000) {
    return String(value);
  }

  if (value < 1000000) {
    return (value / 1000).toFixed(1) + "k";
  }

  return (value / 1000000).toFixed(2) + "M";
}

function formatDateTime(value) {
  const timestamp = toTimestamp(value);

  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(state.locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatExactDateInput(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  const parts = [];

  if (digits.length <= 4) {
    return digits;
  }

  parts.push(digits.slice(0, 4));

  if (digits.length <= 6) {
    parts.push(digits.slice(4));
    return parts.join("/");
  }

  parts.push(digits.slice(4, 6));
  parts.push(digits.slice(6));
  return parts.join("/");
}

function parseExactDateFilter(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (!digits.length) {
    return { status: "empty" };
  }

  if (digits.length < 8) {
    return { status: "invalid" };
  }

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));

  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return { status: "invalid" };
  }

  return {
    status: "ready",
    key: digits.slice(0, 4) + "-" + digits.slice(4, 6) + "-" + digits.slice(6, 8),
  };
}

function getSessionDateKey(session) {
  const timestamp = toTimestamp(session.updatedAt || session.lastModified || session.createdAt);

  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return date.getFullYear() + "-" + month + "-" + day;
}

function makeOverviewItem(label, value) {
  return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(String(value === undefined || value === null ? "-" : value)) + "</dd></div>";
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function setBadgeText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function setBadgeTone(node, tone = "neutral") {
  if (node) {
    node.dataset.tone = tone;
  }
}

function getMetadataSearchQuery() {
  return elements.searchInput.value.trim();
}

function getConversationSearchQuery() {
  return elements.conversationSearchInput.value.trim();
}

function highlightSearchText(value, query) {
  const text = String(value === undefined || value === null ? "" : value);
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) {
    return escapeHtml(text);
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();

  if (!lowerQuery || !lowerText.includes(lowerQuery)) {
    return escapeHtml(text);
  }

  const parts = [];
  let cursor = 0;

  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerQuery, cursor);

    if (index === -1) {
      parts.push(escapeHtml(text.slice(cursor)));
      break;
    }

    parts.push(escapeHtml(text.slice(cursor, index)));
    parts.push("<mark class=\"search-highlight\">" + escapeHtml(text.slice(index, index + normalizedQuery.length)) + "</mark>");
    cursor = index + normalizedQuery.length;
  }

  return parts.join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function handleError(error) {
  console.error(error);
  closeModalDialog();
  state.previewRequestId += 1;
  state.decodeProgress = null;
  state.enrichProgress = null;

  const message = (error && error.message) || t("errors.unknown");

  elements.statusBadge.textContent = t("badge.error");
  setBadgeTone(elements.statusBadge, "danger");
  elements.statusText.textContent = message;
  renderEmptyList(message);
  elements.detailPreview.innerHTML = "<p class=\"empty-state\">" + escapeHtml(message) + "</p>";
}

window.__dsh = { state: state, t: t, applyFilters: applyFilters, scanSessions: scanSessions };
