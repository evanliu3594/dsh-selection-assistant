// src/index.ts
import { homedir } from "node:os";
import { join as join4 } from "node:path";

// src/settings.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/contract.ts
var LIMITS = {
  longPressMs: { min: 200, max: 1500 },
  captureDelayMs: { min: 50, max: 500 },
  maxVisibleActions: { min: 1, max: 8 },
  scale: { min: 0.85, max: 1.25 },
  opacity: { min: 0.2, max: 1 },
  resultWidth: { min: 300, max: 900 },
  resultHeight: { min: 200, max: 900 },
  maxActions: 20
};
var ACTION_ICONS = [
  "translate",
  "explain",
  "summarize",
  "search",
  "copy",
  "optimize",
  "sparkle"
];
var ROUTE_PREFIX = "/selection-assistant";
var PREVIEW_TEXT = "DeepSeek Harness \u662F\u4E00\u4E2A\u672C\u5730 AI \u667A\u80FD\u4F53\u8FD0\u884C\u73AF\u5883\u3002\u9009\u4E2D\u8FD9\u6BB5\u6587\u5B57\u5E76\u957F\u6309 Ctrl\uFF0C\u5C31\u80FD\u770B\u5230\u5212\u8BCD\u52A9\u624B\u3002";
var SYSTEM_PROMPTS = {
  translate: "\u4F60\u662F\u4E25\u8C28\u7684\u7FFB\u8BD1\u5F15\u64CE\uFF0C\u53EA\u8F93\u51FA\u8BD1\u6587\uFF0C\u4E0D\u89E3\u91CA\u3001\u4E0D\u52A0\u5F15\u53F7\u3001\u4E0D\u6DFB\u52A0\u539F\u6587\u6CA1\u6709\u7684\u5185\u5BB9\u3002",
  explain: "",
  summarize: "",
  optimize: "",
  custom: ""
};
var SYSTEM_PROMPTS_EN = {
  translate: "You are a precise translation engine. Output the translation only: no explanation, no quotation marks, no added content.",
  explain: "",
  summarize: "",
  optimize: "",
  custom: ""
};
function defaultPrompt(preset, language, target, fallback) {
  if (language === "en") {
    switch (preset) {
      case "translate":
        return `Translate the following text into ${target}. If it is already in ${target}, translate it into ${fallback}. Preserve paragraphs and list structure.

{{text}}`;
      case "explain":
        return `Explain the following text in plain language: what it means, the context, and the key concepts. Define terms before using them. Keep it under 300 words.

{{text}}`;
      case "summarize":
        return `Summarize the following text in one paragraph of at most 150 words. Keep the key points only.

{{text}}`;
      case "optimize":
        return `Rewrite the following text to be clearer, more accurate and more professional, preserving the original meaning. Output only the rewritten text.

{{text}}`;
      default:
        return "{{text}}";
    }
  }
  switch (preset) {
    case "translate":
      return `\u628A\u4E0B\u9762\u7684\u6587\u672C\u7FFB\u8BD1\u6210${target}\u3002\u5982\u679C\u5B83\u5DF2\u7ECF\u662F${target}\uFF0C\u5C31\u7FFB\u8BD1\u6210${fallback}\u3002\u4FDD\u7559\u6BB5\u843D\u4E0E\u5217\u8868\u7ED3\u6784\u3002\u53EA\u8F93\u51FA\u8BD1\u6587\u3002

{{text}}`;
    case "explain":
      return `\u7528\u901A\u4FD7\u7684\u8BED\u8A00\u89E3\u91CA\u4E0B\u9762\u8FD9\u6BB5\u6587\u5B57\uFF1A\u5B83\u662F\u4EC0\u4E48\u610F\u601D\u3001\u80CC\u666F\u662F\u4EC0\u4E48\u3001\u5173\u952E\u6982\u5FF5\u6709\u54EA\u4E9B\u3002\u672F\u8BED\u5148\u7ED9\u4E00\u53E5\u5B9A\u4E49\u3002\u4E0D\u8D85\u8FC7 300 \u5B57\u3002

{{text}}`;
    case "summarize":
      return `\u7528\u4E00\u6BB5\u8BDD\u6982\u62EC\u4E0B\u9762\u6587\u5B57\u7684\u6838\u5FC3\u5185\u5BB9\uFF0C\u4E0D\u8D85\u8FC7 150 \u5B57\uFF0C\u53EA\u4FDD\u7559\u8981\u70B9\uFF0C\u4E0D\u590D\u8FF0\u539F\u6587\u3002

{{text}}`;
    case "optimize":
      return `\u6DA6\u8272\u4E0B\u9762\u7684\u6587\u5B57\uFF1A\u66F4\u901A\u987A\u3001\u66F4\u51C6\u786E\u3001\u66F4\u4E13\u4E1A\uFF0C\u4FDD\u7559\u539F\u610F\u4E0E\u4FE1\u606F\u91CF\u3002\u53EA\u8F93\u51FA\u6DA6\u8272\u540E\u7684\u6587\u5B57\u3002

{{text}}`;
    default:
      return "{{text}}";
  }
}
function createDefaultSettings() {
  const zh = "zh";
  return {
    version: 1,
    enabled: true,
    trigger: { mode: "ctrl", longPressMs: 500, shortcut: "Ctrl+Alt+Q", captureDelayMs: 120 },
    toolbar: { compact: false, maxVisibleActions: 6, scale: 1 },
    result: {
      followToolbar: true,
      rememberSize: true,
      autoClose: true,
      alwaysOnTop: true,
      opacity: 0.96,
      width: 500,
      height: 400
    },
    model: { provider: "", model: "", reasoningEffort: "", temperature: null },
    language: { ui: zh, target: "\u7B80\u4F53\u4E2D\u6587", fallback: "English" },
    appFilter: { mode: "off", processes: [] },
    actions: [
      {
        id: "translate",
        kind: "llm",
        preset: "translate",
        labelZh: "\u7FFB\u8BD1",
        labelEn: "Translate",
        icon: "translate",
        enabled: true,
        order: 10,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      },
      {
        id: "explain",
        kind: "llm",
        preset: "explain",
        labelZh: "\u89E3\u91CA",
        labelEn: "Explain",
        icon: "explain",
        enabled: true,
        order: 20,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      },
      {
        id: "summarize",
        kind: "llm",
        preset: "summarize",
        labelZh: "\u603B\u7ED3",
        labelEn: "Summarize",
        icon: "summarize",
        enabled: true,
        order: 30,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      },
      {
        id: "search",
        kind: "search",
        preset: "custom",
        labelZh: "\u641C\u7D22",
        labelEn: "Search",
        icon: "search",
        enabled: true,
        order: 40,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      },
      {
        id: "copy",
        kind: "copy",
        preset: "custom",
        labelZh: "\u590D\u5236",
        labelEn: "Copy",
        icon: "copy",
        enabled: true,
        order: 50,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      },
      {
        id: "optimize",
        kind: "llm",
        preset: "optimize",
        labelZh: "\u6DA6\u8272",
        labelEn: "Optimize",
        icon: "optimize",
        enabled: false,
        order: 60,
        systemPrompt: "",
        prompt: "",
        searchUrl: "",
        model: { provider: "", model: "" }
      }
    ],
    advanced: { pwshPath: "", logLevel: "info" }
  };
}

// src/settings.ts
var SETTINGS_VERSION = 1;
var SETTINGS_FILE = "settings.json";
function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function oneOf(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
function text(value, fallback, maxLength = 2e3) {
  if (typeof value !== "string") return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
function textList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergePatch(base, patch) {
  if (!isRecord(base) || !isRecord(patch)) return patch === void 0 ? base : patch;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === void 0) continue;
    const current = next[key];
    next[key] = isRecord(current) && isRecord(value) ? mergePatch(current, value) : value;
  }
  return next;
}
var ICONS = ACTION_ICONS;
var PRESETS = ["translate", "explain", "summarize", "optimize", "custom"];
var KINDS = ["llm", "search", "copy"];
function sanitizeAction(raw, index) {
  if (!isRecord(raw)) return void 0;
  const id = text(raw.id, "", 64);
  if (id === "" || !/^[A-Za-z0-9_-]+$/.test(id)) return void 0;
  const kind = oneOf(raw.kind, KINDS, "llm");
  const preset = oneOf(raw.preset, PRESETS, "custom");
  const icon = oneOf(raw.icon, ICONS, "sparkle");
  const model = isRecord(raw.model) ? raw.model : {};
  return {
    id,
    kind,
    preset,
    labelZh: text(raw.labelZh, id, 40),
    labelEn: text(raw.labelEn, id, 40),
    icon,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    order: clampNumber(raw.order, (index + 1) * 10, 0, 1e4),
    systemPrompt: text(raw.systemPrompt, "", 8e3),
    prompt: text(raw.prompt, "", 8e3),
    searchUrl: text(raw.searchUrl, "", 2e3),
    model: {
      provider: text(model.provider, "", 120),
      model: text(model.model, "", 120)
    }
  };
}
function sanitizeActions(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = /* @__PURE__ */ new Set();
  const actions = [];
  for (const [index, entry] of list.entries()) {
    if (actions.length >= LIMITS.maxActions) break;
    const action = sanitizeAction(entry, index);
    if (action === void 0 || seen.has(action.id)) continue;
    seen.add(action.id);
    actions.push(action);
  }
  if (actions.length === 0) return createDefaultSettings().actions;
  return actions.sort((left, right) => left.order - right.order);
}
function sanitizeSettings(raw) {
  const defaults = createDefaultSettings();
  const value = isRecord(raw) ? raw : {};
  const trigger = isRecord(value.trigger) ? value.trigger : {};
  const toolbar = isRecord(value.toolbar) ? value.toolbar : {};
  const result = isRecord(value.result) ? value.result : {};
  const model = isRecord(value.model) ? value.model : {};
  const language = isRecord(value.language) ? value.language : {};
  const appFilter = isRecord(value.appFilter) ? value.appFilter : {};
  const advanced = isRecord(value.advanced) ? value.advanced : {};
  return {
    version: SETTINGS_VERSION,
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    trigger: {
      mode: oneOf(trigger.mode, ["selection", "ctrl", "shortcut"], defaults.trigger.mode),
      longPressMs: clampNumber(trigger.longPressMs, defaults.trigger.longPressMs, LIMITS.longPressMs.min, LIMITS.longPressMs.max),
      shortcut: text(trigger.shortcut, defaults.trigger.shortcut, 60),
      captureDelayMs: clampNumber(
        trigger.captureDelayMs,
        defaults.trigger.captureDelayMs,
        LIMITS.captureDelayMs.min,
        LIMITS.captureDelayMs.max
      )
    },
    toolbar: {
      compact: typeof toolbar.compact === "boolean" ? toolbar.compact : defaults.toolbar.compact,
      maxVisibleActions: clampNumber(
        toolbar.maxVisibleActions,
        defaults.toolbar.maxVisibleActions,
        LIMITS.maxVisibleActions.min,
        LIMITS.maxVisibleActions.max
      ),
      scale: clampNumber(toolbar.scale, defaults.toolbar.scale, LIMITS.scale.min, LIMITS.scale.max)
    },
    result: {
      followToolbar: typeof result.followToolbar === "boolean" ? result.followToolbar : defaults.result.followToolbar,
      rememberSize: typeof result.rememberSize === "boolean" ? result.rememberSize : defaults.result.rememberSize,
      autoClose: typeof result.autoClose === "boolean" ? result.autoClose : defaults.result.autoClose,
      alwaysOnTop: typeof result.alwaysOnTop === "boolean" ? result.alwaysOnTop : defaults.result.alwaysOnTop,
      opacity: clampNumber(result.opacity, defaults.result.opacity, LIMITS.opacity.min, LIMITS.opacity.max),
      width: clampNumber(result.width, defaults.result.width, LIMITS.resultWidth.min, LIMITS.resultWidth.max),
      height: clampNumber(result.height, defaults.result.height, LIMITS.resultHeight.min, LIMITS.resultHeight.max)
    },
    model: {
      provider: text(model.provider, defaults.model.provider, 120),
      model: text(model.model, defaults.model.model, 120),
      reasoningEffort: text(model.reasoningEffort, defaults.model.reasoningEffort, 60),
      temperature: model.temperature === null || model.temperature === void 0 ? null : clampNumber(model.temperature, 1, 0, 2)
    },
    language: {
      ui: oneOf(language.ui, ["zh", "en"], defaults.language.ui),
      target: text(language.target, defaults.language.target, 60),
      fallback: text(language.fallback, defaults.language.fallback, 60)
    },
    appFilter: {
      mode: oneOf(appFilter.mode, ["off", "blacklist", "whitelist"], defaults.appFilter.mode),
      processes: textList(appFilter.processes, defaults.appFilter.processes).slice(0, 100)
    },
    actions: sanitizeActions(value.actions),
    advanced: {
      pwshPath: text(advanced.pwshPath, defaults.advanced.pwshPath, 500),
      logLevel: oneOf(advanced.logLevel, ["error", "warn", "info", "debug"], defaults.advanced.logLevel)
    }
  };
}
var SettingsStore = class {
  /**
   * @param dataDir - plugin data directory; created when missing.
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, SETTINGS_FILE);
    this.settings = this.read();
  }
  dataDir;
  file;
  settings;
  listeners = /* @__PURE__ */ new Set();
  /** Settings file path. */
  get path() {
    return this.file;
  }
  /** Current settings snapshot (treat as immutable). */
  get() {
    return this.settings;
  }
  /** Read the file, falling back to defaults; a corrupt file is preserved as `.bak`. */
  read() {
    if (!existsSync(this.file)) {
      const defaults = createDefaultSettings();
      this.write(defaults);
      return defaults;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return sanitizeSettings(raw);
    } catch {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
      }
      const defaults = createDefaultSettings();
      this.write(defaults);
      return defaults;
    }
  }
  /** Atomic write of one full document. */
  write(settings) {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}
`, "utf8");
    renameSync(temporary, this.file);
  }
  /** Replace the whole document (used by tests and resets). */
  replace(settings) {
    this.settings = sanitizeSettings(settings);
    this.write(this.settings);
    for (const listener of this.listeners) listener(this.settings);
    return this.settings;
  }
  /** Apply a deep-merged patch, sanitize, persist, and notify listeners. */
  patch(patch) {
    const merged = mergePatch(this.settings, patch);
    const next = sanitizeSettings(merged);
    this.settings = next;
    this.write(next);
    for (const listener of this.listeners) listener(next);
    return next;
  }
  /** Subscribe to saved documents; the disposer detaches. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
};

// src/llm.ts
var LlmError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LlmError";
  }
  code;
};
var MAX_OUTPUT_TOKENS = 4096;
var PROVIDER_CACHE_MS = 6e4;
function replaceAll(haystack, needle, value) {
  return haystack.split(needle).join(value);
}
function buildActionPrompt(action, settings, text2) {
  const locale = settings.language.ui;
  const preset = action.preset;
  const systemDefaults = locale === "en" ? SYSTEM_PROMPTS_EN : SYSTEM_PROMPTS;
  const system = action.systemPrompt.trim() !== "" ? action.systemPrompt : systemDefaults[preset];
  const template = action.prompt.trim() !== "" ? action.prompt : defaultPrompt(preset, locale, settings.language.target, settings.language.fallback);
  let user = template;
  user = replaceAll(user, "{{target}}", settings.language.target);
  user = replaceAll(user, "{{fallback}}", settings.language.fallback);
  user = replaceAll(user, "{{text}}", text2);
  if (!template.includes("{{text}}")) user = `${template.trimEnd()}

${text2}`;
  return { system, user };
}
function interpretChunk(chunk) {
  if (typeof chunk !== "object" || chunk === null) return void 0;
  const value = chunk;
  if (value.type === "text-delta" && typeof value.text === "string") return { type: "delta", text: value.text };
  if (value.type === "finish") {
    const kind = value.reason?.kind;
    if (kind === "stop" || kind === "max-tokens" || kind === "aborted" || kind === "tool-calls") {
      return { type: "done", reason: kind };
    }
    if (kind === "error") {
      const failure = value.reason.failure;
      throw new LlmError(
        typeof failure?.code === "string" ? failure.code : "llm-failed",
        typeof failure?.message === "string" ? failure.message : "\u6A21\u578B\u8C03\u7528\u5931\u8D25\u3002"
      );
    }
    return { type: "done", reason: "stop" };
  }
  return void 0;
}
var LlmBridge = class {
  /**
   * @param getService - returns the live `ctx.llm` service or undefined.
   * @param getDefaultModel - returns the live `ctx.agentDefaultModel` service or undefined.
   */
  constructor(getService, getDefaultModel) {
    this.getService = getService;
    this.getDefaultModel = getDefaultModel;
  }
  getService;
  getDefaultModel;
  providersCache;
  /** The host default route, or empty strings when no service reports one. */
  defaults() {
    try {
      const selection = this.getDefaultModel()?.currentSelection();
      if (selection !== void 0 && selection.provider !== "") {
        return {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort ?? ""
        };
      }
    } catch {
    }
    return { provider: "", model: "", reasoningEffort: "" };
  }
  /** Resolve the route for one action: action override, then global, then host default. */
  resolveRoute(action, settings) {
    const defaults = this.defaults();
    const provider = action.model.provider || settings.model.provider || defaults.provider;
    const model = action.model.model || settings.model.model || defaults.model;
    const reasoningEffort = settings.model.reasoningEffort || (provider === defaults.provider && model === defaults.model ? defaults.reasoningEffort : "");
    if (provider === "" || model === "") {
      throw new LlmError("no-model", "\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\uFF1A\u8BF7\u5728\u8BBE\u7F6E\u91CC\u9009\u62E9\u670D\u52A1\u4E0E\u6A21\u578B\uFF0C\u6216\u5148\u5728 DSH \u4E2D\u914D\u7F6E\u9ED8\u8BA4\u6A21\u578B\u3002");
    }
    return { provider, model, reasoningEffort };
  }
  /**
   * Run one action and stream its chunks.
   * @param action - configured action.
   * @param text - captured selection.
   * @param settings - current settings.
   * @param signal - cancellation from the closed result window.
   */
  async *runAction(action, text2, settings, signal) {
    const service = this.getService();
    if (service === void 0) {
      throw new LlmError("no-llm-service", "\u5F53\u524D profile \u6CA1\u6709 LLM \u670D\u52A1\uFF0C\u65E0\u6CD5\u8C03\u7528 DeepSeek\u3002");
    }
    const route = this.resolveRoute(action, settings);
    const { system, user } = buildActionPrompt(action, settings, text2);
    const request = {
      role: "user",
      content: [{ type: "text", text: user }]
    };
    const callConfig = {
      provider: route.provider,
      model: route.model,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...route.reasoningEffort !== "" ? { reasoningEffort: route.reasoningEffort } : {},
      ...settings.model.temperature === null ? {} : { temperature: settings.model.temperature }
    };
    yield { type: "meta", provider: route.provider, model: route.model };
    signal.throwIfAborted();
    let call;
    try {
      call = service.prepareCall === void 0 ? { config: callConfig, stream: (options2) => service.stream(options2) } : await service.prepareCall(callConfig, signal);
    } catch (error) {
      throw toLlmError(error);
    }
    const options = {
      ...call.config,
      messages: [request],
      signal,
      ...system.trim() !== "" ? { system } : {}
    };
    try {
      for await (const chunk of call.stream(options)) {
        const interpreted = interpretChunk(chunk);
        if (interpreted === void 0) continue;
        yield interpreted;
        if (interpreted.type === "done") return;
      }
    } catch (error) {
      if (signal.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      throw toLlmError(error);
    }
    yield { type: "done", reason: "stop" };
  }
  /** Collect one non-streaming completion (settings page "测试" button). */
  async complete(text2, settings, provider, model, signal) {
    const action = settings.actions.find((entry) => entry.id === "translate") ?? settings.actions[0];
    if (action === void 0) throw new LlmError("no-action", "\u6CA1\u6709\u53EF\u7528\u7684\u52A8\u4F5C\u3002");
    const effective = sanitizeRouteOverride(settings, action, provider, model);
    let output = "";
    for await (const chunk of this.runAction(effective, text2, settings, signal)) {
      if (chunk.type === "delta") output += chunk.text;
    }
    return output;
  }
  /** List providers and models with reasoning metadata, cached briefly. */
  async providers() {
    const cached = this.providersCache;
    if (cached !== void 0 && Date.now() - cached.at < PROVIDER_CACHE_MS) return cached.value;
    const service = this.getService();
    if (service === void 0) return [];
    let providers = [];
    try {
      providers = service.listProviders();
    } catch {
      return [];
    }
    const result = [];
    for (const provider of providers) {
      const models = [];
      try {
        const listed = await service.listModels(provider.id);
        for (const model of listed.slice(0, 60)) {
          let reasoningEfforts = [];
          let defaultReasoningEffort = "";
          if (service.resolveModelInfo !== void 0) {
            try {
              const resolved = await service.resolveModelInfo(provider.id, model.id, AbortSignal.timeout(4e3));
              reasoningEfforts = (resolved.reasoning?.efforts ?? []).map((effort) => ({
                id: effort.id,
                name: effort.name ?? effort.id
              }));
              defaultReasoningEffort = resolved.reasoning?.defaultEffort ?? "";
            } catch {
            }
          }
          models.push({
            id: model.id,
            name: model.name ?? model.id,
            reasoningEfforts,
            defaultReasoningEffort
          });
        }
      } catch {
      }
      result.push({ provider: provider.id, name: provider.name ?? provider.id, models });
    }
    result.sort((left, right) => {
      const leftDeepSeek = left.provider.includes("deepseek") ? 0 : 1;
      const rightDeepSeek = right.provider.includes("deepseek") ? 0 : 1;
      return leftDeepSeek - rightDeepSeek || left.provider.localeCompare(right.provider);
    });
    this.providersCache = { at: Date.now(), value: result };
    return result;
  }
  /** Drop the cached provider catalog (after settings that might change routes). */
  invalidate() {
    this.providersCache = void 0;
  }
};
function sanitizeRouteOverride(settings, action, provider, model) {
  if (provider === "" && model === "") return action;
  return {
    ...action,
    model: {
      provider: provider !== "" ? provider : action.model.provider,
      model: model !== "" ? model : action.model.model
    }
  };
}
function toLlmError(error) {
  if (error instanceof LlmError) return error;
  const value = error;
  const code = typeof value?.code === "string" ? value.code : "llm-failed";
  const message = typeof value?.message === "string" && value.message !== "" ? value.message : "\u6A21\u578B\u8C03\u7528\u5931\u8D25\u3002";
  const friendly = {
    MODEL_UNSUPPORTED: "\u6240\u9009\u6A21\u578B\u4E0D\u53D7\u8BE5\u670D\u52A1\u652F\u6301\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6A21\u578B\u3002",
    MISSING_CREDENTIAL: "DeepSeek \u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u5148\u5728 DSH \u4E2D\u767B\u5F55\u6216\u914D\u7F6E API Key\u3002",
    INVALID_CREDENTIAL: "DeepSeek \u51ED\u636E\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u6216\u66F4\u65B0 API Key\u3002",
    AUTH: "\u6A21\u578B\u670D\u52A1\u62D2\u7EDD\u9274\u6743\uFF0C\u8BF7\u68C0\u67E5 DSH \u7684\u6A21\u578B\u914D\u7F6E\u3002",
    CLIENT_UPGRADE_REQUIRED: "\u5F53\u524D\u5BA2\u6237\u7AEF\u7248\u672C\u4E0D\u652F\u6301\u6240\u9009\u6A21\u578B\uFF0C\u8BF7\u5347\u7EA7 DSH\u3002"
  };
  return new LlmError(code, friendly[code] ?? `\u6A21\u578B\u8C03\u7528\u5931\u8D25\uFF1A${message}`);
}

// src/helper.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
var PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
var HELPER_SCRIPT = join2(PACKAGE_ROOT, "helper", "SelectionAssistant.ps1");
var MAX_AUTO_RESTARTS = 5;
var RESTART_BASE_MS = 1200;
function readVersion() {
  try {
    const raw = JSON.parse(readFileSync2(join2(PACKAGE_ROOT, "package.json"), "utf8"));
    const version = raw.version;
    return typeof version === "string" ? version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}
var BUNDLE_VERSION = readVersion();
function findPwshOnDisk(explicit) {
  const candidates = [];
  if (explicit.trim() !== "") candidates.push(explicit.trim());
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(";")) {
    if (directory.trim() === "") continue;
    candidates.push(join2(directory.trim(), "pwsh.exe"));
  }
  const localAppData = process.env.LOCALAPPDATA ?? "";
  if (localAppData !== "") candidates.push(join2(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"));
  const userProfile = process.env.USERPROFILE ?? "";
  if (userProfile !== "") candidates.push(join2(userProfile, "AppData", "Local", "Microsoft", "WindowsApps", "pwsh.exe"));
  if (process.env.ProgramFiles !== void 0) candidates.push(join2(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  if (process.env.ProgramFiles !== void 0) candidates.push(join2(process.env.ProgramFiles, "PowerShell", "7-preview", "pwsh.exe"));
  if (process.env.ProgramData !== void 0) candidates.push(join2(process.env.ProgramData, "chocolatey", "bin", "pwsh.exe"));
  let windowsAppsGuess;
  for (const candidate of candidates) {
    try {
      if (existsSync2(candidate)) return candidate;
    } catch {
    }
    if (windowsAppsGuess === void 0 && /WindowsApps[\\/](?:[^\\/]+[\\/])?pwsh\.exe$/i.test(candidate)) {
      windowsAppsGuess = candidate;
    }
  }
  return windowsAppsGuess;
}
function isLegacyPowerShell(path) {
  return basename(path).toLowerCase() === "powershell.exe";
}
var HelperManager = class {
  options;
  stateFile;
  configFile;
  commandFile;
  child;
  status = { status: "stopped", restarts: 0 };
  intentionalStop = false;
  restartTimer;
  updateTimer;
  readyTimer;
  disposed = false;
  resolvedPwsh;
  constructor(options) {
    this.options = options;
    mkdirSync2(options.dataDir, { recursive: true });
    this.stateFile = join2(options.dataDir, "helper-state.json");
    this.configFile = join2(options.dataDir, "helper-config.json");
    this.commandFile = join2(options.dataDir, "command.json");
  }
  /** Current status snapshot. */
  getStatus() {
    return this.status;
  }
  /** Absolute path of the helper entry point, for the settings page diagnostics. */
  get scriptPath() {
    return HELPER_SCRIPT;
  }
  /** Whether the helper entry point ships with the package. */
  get scriptPresent() {
    return existsSync2(HELPER_SCRIPT);
  }
  /** Publish a status change to listeners. */
  publish(patch) {
    this.status = { ...this.status, ...patch };
    this.options.onStatusChange?.(this.status);
  }
  /** Resolved PowerShell path, once a launch attempt resolved one. */
  get pwshPath() {
    return this.resolvedPwsh ?? "";
  }
  /** Resolve PowerShell candidates in priority order; the first that launches wins. */
  async resolvePwshCandidates() {
    const candidates = [];
    const push = (candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === "" || candidates.includes(trimmed) || isLegacyPowerShell(trimmed)) return;
      candidates.push(trimmed);
    };
    const settings = this.options.getSettings();
    const configured = settings.advanced.pwshPath.trim();
    const override = (this.options.pwshPathOverride ?? "").trim();
    for (const explicit of [configured, override]) {
      if (explicit === "" || isLegacyPowerShell(explicit)) continue;
      try {
        const resolved = await this.options.getSubprocess()?.resolveExecutable?.(explicit);
        if (resolved !== void 0 && resolved !== "") push(resolved);
      } catch {
      }
      push(explicit);
    }
    try {
      const resolved = await this.options.getSubprocess()?.resolveExecutable?.("pwsh");
      if (resolved !== void 0 && resolved !== "") push(resolved);
    } catch {
    }
    const found = findPwshOnDisk("");
    if (found !== void 0) push(found);
    push("pwsh");
    return candidates;
  }
  /** First candidate path, for diagnostics and the settings page. */
  async resolvePwsh() {
    return (await this.resolvePwshCandidates())[0];
  }
  /** Write the helper config file atomically. */
  writeConfig(endpoint, pwshPath) {
    const settings = this.options.getSettings();
    const config = {
      version: 1,
      endpoint: endpoint.url,
      token: endpoint.token,
      dataDir: this.options.dataDir,
      logPath: this.options.logPath,
      locale: settings.language.ui,
      trigger: { ...settings.trigger },
      toolbar: { ...settings.toolbar },
      result: this.rememberedResult(settings),
      appFilter: { ...settings.appFilter },
      actions: settings.actions.filter((action) => action.enabled).sort((left, right) => left.order - right.order).map((action) => ({
        id: action.id,
        kind: action.kind,
        label: settings.language.ui === "en" ? action.labelEn || action.labelZh : action.labelZh || action.labelEn,
        icon: action.icon,
        enabled: action.enabled,
        order: action.order,
        searchUrl: action.searchUrl
      })),
      debug: settings.advanced.logLevel === "debug"
    };
    const temporary = `${this.configFile}.tmp`;
    writeFileSync2(temporary, `${JSON.stringify(config, null, 2)}
`, "utf8");
    renameSync2(temporary, this.configFile);
    this.options.logger.info(`helper config written (${String(config.actions.length)} action(s), pwsh=${pwshPath})`);
    return config;
  }
  /** Remembered result size overrides the configured default when enabled. */
  rememberedResult(settings) {
    if (!settings.result.rememberSize) return { ...settings.result };
    try {
      const raw = JSON.parse(readFileSync2(this.stateFile, "utf8"));
      const state = raw;
      const width = typeof state.resultWidth === "number" ? state.resultWidth : settings.result.width;
      const height = typeof state.resultHeight === "number" ? state.resultHeight : settings.result.height;
      return { ...settings.result, width, height };
    } catch {
      return { ...settings.result };
    }
  }
  /** Append helper stdout/stderr lines to the helper log. */
  wireOutput(stream, label) {
    if (stream === null) return;
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8e3) buffer = buffer.slice(-8e3);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") this.options.logger.info(`[helper:${label}] ${line}`);
      }
    });
    stream.on("error", () => {
    });
  }
  /** Wire one spawned child: output capture, exit handling, and the ready watchdog. */
  attachChild(child, pwsh) {
    this.child = child;
    this.resolvedPwsh = pwsh;
    this.wireOutput(child.stdout, "out");
    this.wireOutput(child.stderr, "err");
    child.once("error", (error) => {
      this.options.logger.error(`helper process error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.clearReadyTimer();
      this.child = void 0;
      if (this.disposed || this.intentionalStop) {
        this.publish({ status: "stopped", pid: void 0 });
        return;
      }
      const detail = signal !== null ? `signal=${signal}` : `code=${String(code ?? "null")}`;
      this.options.logger.error(`helper exited unexpectedly (${detail})`);
      this.publish({ status: "error", lastError: `\u52A9\u624B\u8FDB\u7A0B\u610F\u5916\u9000\u51FA\uFF08${detail}\uFF09\u3002`, pid: void 0 });
      this.scheduleRestart();
    });
    this.publish({ status: "starting", pid: child.pid, startedAt: Date.now() });
    this.armReadyTimer();
    this.options.logger.info(`helper launched with ${pwsh} (pid=${String(child.pid ?? "")})`);
  }
  /** Spawn one candidate and resolve once the OS reports success. */
  spawnCandidate(pwsh, endpoint) {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_SCRIPT, "-ConfigPath", this.configFile];
    this.writeConfig(endpoint, pwsh);
    return new Promise((resolveSpawn, rejectSpawn) => {
      let child;
      try {
        child = spawn(pwsh, args, {
          cwd: this.options.dataDir,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, DSH_SELECTION_ASSISTANT_DATA: this.options.dataDir }
        });
      } catch (error) {
        rejectSpawn(error);
        return;
      }
      const onSpawn = () => {
        child.off("error", onError);
        resolveSpawn(child);
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        rejectSpawn(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
  /** Arm the watchdog that reports a helper which never announces readiness. */
  armReadyTimer() {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      if (this.status.status === "starting") {
        this.options.logger.warn("helper did not report ready within 15s");
        this.publish({ status: "error", lastError: "\u52A9\u624B\u8FDB\u7A0B\u542F\u52A8\u540E 15 \u79D2\u5185\u6CA1\u6709\u62A5\u544A\u5C31\u7EEA\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\u3002" });
      }
    }, 15e3);
    this.readyTimer.unref?.();
  }
  /** Start the helper when the feature is enabled and the platform supports it. */
  async start() {
    if (this.disposed) return;
    const settings = this.options.getSettings();
    if (!settings.enabled) {
      this.publish({ status: "stopped", lastError: "" });
      return;
    }
    if (process.platform !== "win32") {
      this.publish({ status: "error", lastError: "\u5212\u8BCD\u52A9\u624B\u76EE\u524D\u53EA\u652F\u6301 Windows\u3002" });
      return;
    }
    if (!this.scriptPresent) {
      this.publish({ status: "error", lastError: `\u627E\u4E0D\u5230\u52A9\u624B\u811A\u672C\uFF1A${HELPER_SCRIPT}` });
      return;
    }
    const endpoint = this.options.getEndpoint();
    if (endpoint === void 0) {
      this.publish({ status: "error", lastError: "\u52A9\u624B\u901A\u4FE1\u7AEF\u53E3\u5C1A\u672A\u5C31\u7EEA\u3002" });
      return;
    }
    this.intentionalStop = false;
    this.publish({ status: "starting", lastError: "" });
    const candidates = await this.resolvePwshCandidates();
    const failures = [];
    for (const pwsh of candidates) {
      try {
        const child = await this.spawnCandidate(pwsh, endpoint);
        this.attachChild(child, pwsh);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${pwsh}: ${message}`);
        this.options.logger.warn(`helper spawn candidate failed (${pwsh}): ${message}`);
      }
    }
    this.publish({
      status: "error",
      lastError: `\u65E0\u6CD5\u542F\u52A8\u52A9\u624B\u8FDB\u7A0B\u3002\u5DF2\u5C1D\u8BD5\uFF1A${failures.join("\uFF1B")}\u3002\u8BF7\u5728\u8BBE\u7F6E \u2192 \u9AD8\u7EA7 \u2192 pwsh \u8DEF\u5F84\u91CC\u586B\u5199 pwsh.exe \u7684\u5B8C\u6574\u8DEF\u5F84\u3002`
    });
  }
  /** The helper announced readiness. */
  markReady() {
    this.clearReadyTimer();
    this.publish({ status: "running", lastError: "", startedAt: this.status.startedAt ?? Date.now() });
    this.options.logger.info(`helper ready (pid=${String(this.status.pid ?? "")})`);
  }
  /** The helper reported a fatal error. */
  markError(message) {
    this.clearReadyTimer();
    this.publish({ status: "error", lastError: message });
  }
  /** One automatic restart after an unexpected exit, bounded by MAX_AUTO_RESTARTS. */
  scheduleRestart() {
    if (this.disposed) return;
    if (this.status.restarts >= MAX_AUTO_RESTARTS) {
      this.options.logger.error("helper restart budget exhausted; waiting for a manual restart");
      return;
    }
    const attempt = this.status.restarts + 1;
    this.publish({ status: "starting", restarts: attempt });
    this.restartTimer = setTimeout(() => {
      void this.start();
    }, RESTART_BASE_MS * attempt);
    this.restartTimer.unref?.();
  }
  /** Stop the helper; the next start is clean. */
  async stop() {
    this.intentionalStop = true;
    this.clearReadyTimer();
    if (this.restartTimer !== void 0) {
      clearTimeout(this.restartTimer);
      this.restartTimer = void 0;
    }
    const child = this.child;
    this.child = void 0;
    if (child === void 0) {
      this.publish({ status: "stopped", pid: void 0 });
      return;
    }
    try {
      child.stdin?.end();
    } catch {
    }
    await new Promise((resolveStop) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolveStop();
      }, 2500);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
    this.publish({ status: "stopped", pid: void 0, lastError: "" });
  }
  /** Restart on demand (settings button or settings change). */
  async restart() {
    await this.stop();
    this.publish({ status: "starting", restarts: 0, lastError: "" });
    await this.start();
  }
  /** Apply new settings: rewrite config and restart when the helper is live. */
  applySettings() {
    if (this.updateTimer !== void 0) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = void 0;
      const settings = this.options.getSettings();
      if (!settings.enabled) {
        void this.stop();
        return;
      }
      const endpoint = this.options.getEndpoint();
      if (endpoint === void 0) return;
      if (this.child !== void 0) {
        void this.restart();
      } else {
        void this.start();
      }
    }, 350);
    this.updateTimer.unref?.();
  }
  /** Ask the helper to show a preview toolbar and result window. */
  preview(text2) {
    if (this.child === void 0) throw new Error("\u52A9\u624B\u8FDB\u7A0B\u672A\u5728\u8FD0\u884C\uFF0C\u8BF7\u5148\u542F\u52A8\u3002");
    const command = { id: randomUUID(), type: "preview", text: text2 };
    const temporary = `${this.commandFile}.tmp`;
    writeFileSync2(temporary, `${JSON.stringify(command, null, 2)}
`, "utf8");
    renameSync2(temporary, this.commandFile);
    this.options.logger.info("preview command written");
  }
  /** Kill the helper and clear every timer; safe to call twice. */
  async dispose() {
    this.disposed = true;
    if (this.updateTimer !== void 0) clearTimeout(this.updateTimer);
    this.updateTimer = void 0;
    await this.stop();
  }
  /** Clear the readiness watchdog timer. */
  clearReadyTimer() {
    if (this.readyTimer !== void 0) {
      clearTimeout(this.readyTimer);
      this.readyTimer = void 0;
    }
  }
};

// src/server.ts
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { once } from "node:events";
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_SELECTION_CHARS = 2e4;
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}
function fail(res, status, code, message) {
  const body = { ok: false, error: { code, message } };
  sendJson(res, status, body);
}
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("\u8BF7\u6C42\u4F53\u8D85\u8FC7 1 MB \u4E0A\u9650\u3002");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return void 0;
  const text2 = Buffer.concat(chunks).toString("utf8").trim();
  if (text2 === "") return void 0;
  return JSON.parse(text2);
}
function tokenMatches(header, token) {
  if (header === void 0) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function writeEvent(res, event, data) {
  const frame = `event: ${event}
data: ${JSON.stringify(data)}

`;
  if (!res.write(frame)) await once(res, "drain");
}
function buildState(deps) {
  const settings = deps.settings.get();
  const helper = deps.helper.getStatus();
  const defaults = deps.llm.defaults();
  return {
    settings,
    helper,
    platform: {
      os: process.platform,
      arch: process.arch,
      pwsh: deps.pwshPath(),
      supported: deps.platformSupported(),
      reason: deps.platformReason()
    },
    defaults,
    paths: { dataDir: deps.dataDir, log: deps.logPath },
    version: deps.version
  };
}
function tailFile(path, maxLines) {
  try {
    if (!existsSync3(path)) return "";
    const text2 = readFileSync3(path, "utf8");
    const lines = text2.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  } catch {
    return "";
  }
}
function createSettingsHandler(deps) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (path === `${ROUTE_PREFIX}/state`) {
        if (method !== "GET") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 GET\u3002");
        return sendJson(res, 200, { ok: true, state: buildState(deps) });
      }
      if (path === `${ROUTE_PREFIX}/models`) {
        if (method !== "GET") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 GET\u3002");
        const providers = await deps.llm.providers();
        return sendJson(res, 200, { ok: true, providers, defaults: deps.llm.defaults() });
      }
      if (path === `${ROUTE_PREFIX}/settings`) {
        if (method !== "POST") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 POST\u3002");
        const body = await readJsonBody(req);
        const patch = body?.patch;
        if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
          return fail(res, 400, "bad-request", '\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F { "patch": { ... } }\u3002');
        }
        const next = deps.settings.patch(patch);
        deps.onSettingsSaved(next);
        deps.logger.info("settings saved from the settings page");
        return sendJson(res, 200, { ok: true, state: buildState(deps) });
      }
      if (path === `${ROUTE_PREFIX}/test`) {
        if (method !== "POST") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 POST\u3002");
        const body = await readJsonBody(req);
        const provider = typeof body?.provider === "string" ? body.provider : "";
        const model = typeof body?.model === "string" ? body.model : "";
        const sample = typeof body?.text === "string" && body.text.trim() !== "" ? body.text : PREVIEW_TEXT;
        const settings = deps.settings.get();
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        const timeout = setTimeout(() => controller.abort(), 9e4);
        timeout.unref?.();
        try {
          const text2 = await deps.llm.complete(sample, settings, provider, model, controller.signal);
          return sendJson(res, 200, { ok: true, text: text2, provider: provider || settings.model.provider, model: model || settings.model.model });
        } finally {
          clearTimeout(timeout);
        }
      }
      if (path === `${ROUTE_PREFIX}/helper/restart`) {
        if (method !== "POST") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 POST\u3002");
        await deps.helper.restart();
        return sendJson(res, 200, { ok: true, state: buildState(deps) });
      }
      if (path === `${ROUTE_PREFIX}/helper/preview`) {
        if (method !== "POST") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 POST\u3002");
        const body = await readJsonBody(req);
        const sample = typeof body?.text === "string" && body.text.trim() !== "" ? body.text : PREVIEW_TEXT;
        try {
          deps.helper.preview(sample);
        } catch (error) {
          return fail(res, 409, "helper-not-running", error instanceof Error ? error.message : "\u52A9\u624B\u8FDB\u7A0B\u672A\u5728\u8FD0\u884C\u3002");
        }
        return sendJson(res, 200, { ok: true });
      }
      if (path === `${ROUTE_PREFIX}/logs`) {
        if (method !== "GET") return fail(res, 405, "method-not-allowed", "\u8BE5\u8DEF\u7531\u53EA\u652F\u6301 GET\u3002");
        const requested = Number(url.searchParams.get("lines") ?? "200");
        const lines = Number.isFinite(requested) ? Math.min(1e3, Math.max(20, Math.trunc(requested))) : 200;
        const helperText = tailFile(deps.logPath, lines);
        const pluginText = tailFile(deps.pluginLogPath, Math.max(20, Math.trunc(lines / 2)));
        const text2 = `===== plugin.log =====
${pluginText}

===== helper.log =====
${helperText}`;
        return sendJson(res, 200, { ok: true, path: deps.logPath, text: text2 });
      }
      return fail(res, 404, "unknown-route", `\u672A\u77E5\u8DEF\u7531 ${path}`);
    } catch (error) {
      deps.logger.error(`settings route failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) return fail(res, 500, "internal", error instanceof Error ? error.message : "\u5185\u90E8\u9519\u8BEF\u3002");
    }
  };
}
var ActionServer = class {
  /**
   * @param deps - plugin instance state.
   */
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  /** Random bearer token regenerated on every plugin start. */
  token = randomBytes(32).toString("hex");
  server;
  port = 0;
  closed = false;
  /** Endpoint descriptor for the helper config, once listening. */
  get endpoint() {
    if (this.server === void 0 || this.port === 0) return void 0;
    return { url: `http://127.0.0.1:${String(this.port)}`, token: this.token };
  }
  /** Bind an ephemeral loopback port. */
  async start() {
    if (this.server !== void 0 || this.closed) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on("error", (error) => {
      this.deps.logger.error(`action server error: ${error.message}`);
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
    this.server = server;
    this.deps.logger.info(`action server listening on 127.0.0.1:${String(this.port)}`);
    if (this.closed) await this.close();
  }
  /** Close the server and drop every in-flight request. */
  async close() {
    this.closed = true;
    const server = this.server;
    this.server = void 0;
    this.port = 0;
    if (server === void 0) return;
    await new Promise((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
      server.closeAllConnections();
    });
  }
  /** Route one helper request. */
  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/v1/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true });
      }
      if (!tokenMatches(req.headers.authorization, this.token)) {
        return fail(res, 401, "unauthorized", "\u52A9\u624B token \u65E0\u6548\u3002");
      }
      if (url.pathname === "/v1/status" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (body?.state === "ready") this.deps.helper.markReady();
        else if (body?.state === "error") this.deps.helper.markError(typeof body.message === "string" ? body.message : "\u52A9\u624B\u62A5\u544A\u9519\u8BEF\u3002");
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/v1/log" && req.method === "POST") {
        const body = await readJsonBody(req);
        const level = body?.level === "error" || body?.level === "warn" || body?.level === "debug" ? body.level : "info";
        this.deps.logger.log(level, `[helper] ${typeof body?.message === "string" ? body.message : ""}`);
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/v1/action" && req.method === "POST") {
        return await this.streamAction(req, res);
      }
      return fail(res, 404, "unknown-route", `\u672A\u77E5\u8DEF\u7531 ${url.pathname}`);
    } catch (error) {
      this.deps.logger.error(`action server request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) fail(res, 500, "internal", error instanceof Error ? error.message : "\u5185\u90E8\u9519\u8BEF\u3002");
      else res.end();
    }
  }
  /** Stream one action's model output as server-sent events. */
  async streamAction(req, res) {
    const body = await readJsonBody(req);
    const actionId = typeof body?.actionId === "string" ? body.actionId : "";
    const text2 = typeof body?.text === "string" ? body.text : "";
    if (actionId === "" || text2.trim() === "") {
      return fail(res, 400, "bad-request", "\u7F3A\u5C11 actionId \u6216 text\u3002");
    }
    if (text2.length > MAX_SELECTION_CHARS) {
      return fail(res, 413, "too-long", `\u9009\u4E2D\u6587\u672C\u8D85\u8FC7 ${String(MAX_SELECTION_CHARS)} \u5B57\u4E0A\u9650\u3002`);
    }
    const settings = this.deps.settings.get();
    const action = settings.actions.find((entry) => entry.id === actionId);
    if (action === void 0) {
      return fail(res, 404, "unknown-action", `\u52A8\u4F5C ${actionId} \u4E0D\u5B58\u5728\u3002`);
    }
    if (action.kind !== "llm") {
      return fail(res, 400, "local-action", `\u52A8\u4F5C ${actionId} \u5728\u52A9\u624B\u7AEF\u672C\u5730\u6267\u884C\uFF0C\u4E0D\u9700\u8981\u6A21\u578B\u3002`);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    req.on("close", abort);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.flushHeaders?.();
    try {
      const label = settings.language.ui === "en" ? action.labelEn || action.labelZh : action.labelZh || action.labelEn;
      await writeEvent(res, "meta", {
        provider: "",
        model: "",
        label,
        requestId: typeof body?.requestId === "string" ? body.requestId : ""
      });
      let provider = "";
      let model = "";
      for await (const chunk of this.deps.llm.runAction(action, text2, settings, controller.signal)) {
        if (controller.signal.aborted) break;
        if (chunk.type === "meta") {
          provider = chunk.provider;
          model = chunk.model;
          await writeEvent(res, "meta", { provider, model, label });
          continue;
        }
        if (chunk.type === "delta") {
          await writeEvent(res, "delta", { text: chunk.text });
          continue;
        }
        await writeEvent(res, "done", { reason: chunk.reason });
        res.end();
        return;
      }
      if (!res.writableEnded) {
        await writeEvent(res, "done", { reason: "aborted" });
        res.end();
      }
    } catch (error) {
      const code = error.code;
      const message = error instanceof Error ? error.message : "\u6A21\u578B\u8C03\u7528\u5931\u8D25\u3002";
      this.deps.logger.error(`action ${actionId} failed: ${message}`);
      if (!res.writableEnded) {
        try {
          await writeEvent(res, "error", { code: typeof code === "string" ? code : "llm-failed", message });
        } catch {
        }
        res.end();
      }
    }
  }
};
function settingsRoutePaths() {
  return [
    `${ROUTE_PREFIX}/state`,
    `${ROUTE_PREFIX}/settings`,
    `${ROUTE_PREFIX}/models`,
    `${ROUTE_PREFIX}/test`,
    `${ROUTE_PREFIX}/helper/restart`,
    `${ROUTE_PREFIX}/helper/preview`,
    `${ROUTE_PREFIX}/logs`
  ];
}

// src/log.ts
import { appendFileSync, existsSync as existsSync4, mkdirSync as mkdirSync3, renameSync as renameSync3, statSync } from "node:fs";
import { join as join3 } from "node:path";
var MAX_BYTES = 1024 * 1024;
var LEVELS = ["error", "warn", "info", "debug"];
var PluginLogger = class {
  file;
  level;
  host;
  /**
   * @param dataDir - plugin data directory; created when missing.
   * @param level - minimum level to write.
   * @param host - optional DSH host logger to mirror into.
   */
  constructor(dataDir, level = "info", host) {
    mkdirSync3(dataDir, { recursive: true });
    this.file = join3(dataDir, "plugin.log");
    this.level = level;
    this.host = host;
  }
  /** Change the minimum level at runtime (settings edits apply immediately). */
  setLevel(level) {
    this.level = level;
  }
  /** Absolute path of the log file. */
  get path() {
    return this.file;
  }
  /** Write one line. Never throws: logging failure must not break the feature. */
  log(level, message) {
    if (LEVELS.indexOf(level) > LEVELS.indexOf(this.level)) return;
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${message}
`;
    try {
      if (existsSync4(this.file) && statSync(this.file).size > MAX_BYTES) renameSync3(this.file, `${this.file}.1`);
      appendFileSync(this.file, line, "utf8");
    } catch {
    }
    try {
      const mirror = this.host;
      if (mirror !== void 0) {
        if (level === "error") mirror.error(message);
        else if (level === "warn") mirror.warn(message);
        else if (level === "debug") mirror.debug(message);
        else mirror.info(message);
      }
    } catch {
    }
  }
  error(message) {
    this.log("error", message);
  }
  warn(message) {
    this.log("warn", message);
  }
  info(message) {
    this.log("info", message);
  }
  debug(message) {
    this.log("debug", message);
  }
};

// src/index.ts
var name = "selection-assistant";
var inject = [];
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
  return join4(homedir(), ".dsh");
}
function readService(ctx, key) {
  try {
    return ctx.get?.(key);
  } catch {
    return void 0;
  }
}
function apply(rawCtx, config = {}) {
  const ctx = rawCtx ?? {};
  const dataDir = config.dataDir?.trim() ?? "";
  const resolvedDataDir = dataDir !== "" ? dataDir : join4(resolveDshHome(), "selection-assistant");
  let hostLogger;
  try {
    hostLogger = ctx.logger?.("selection-assistant");
  } catch {
    hostLogger = void 0;
  }
  const settings = new SettingsStore(resolvedDataDir);
  const logger = new PluginLogger(resolvedDataDir, settings.get().advanced.logLevel, hostLogger);
  logger.info(`selection-assistant ${BUNDLE_VERSION} loading (dataDir=${resolvedDataDir}, platform=${process.platform})`);
  const llm = new LlmBridge(
    () => readService(ctx, "llm"),
    () => readService(ctx, "agentDefaultModel")
  );
  let actionServer;
  let helperManager;
  const deps = {
    dataDir: resolvedDataDir,
    logPath: join4(resolvedDataDir, "helper.log"),
    pluginLogPath: logger.path,
    version: BUNDLE_VERSION,
    settings,
    llm,
    helper: void 0,
    logger,
    pwshPath: () => helperManager?.pwshPath ?? "",
    platformSupported: () => process.platform === "win32" && (helperManager?.scriptPresent ?? false),
    platformReason: () => {
      if (process.platform !== "win32") return "\u5212\u8BCD\u52A9\u624B\u76EE\u524D\u53EA\u652F\u6301 Windows\u3002";
      if (helperManager?.scriptPresent !== true) return "\u63D2\u4EF6\u5305\u5185\u7F3A\u5C11 helper/SelectionAssistant.ps1\u3002";
      return "";
    },
    onSettingsSaved: (next) => {
      logger.setLevel(next.advanced.logLevel);
      llm.invalidate();
      helperManager?.applySettings();
    }
  };
  actionServer = new ActionServer(deps);
  helperManager = new HelperManager({
    dataDir: resolvedDataDir,
    logPath: deps.logPath,
    logger,
    getSettings: () => settings.get(),
    getSubprocess: () => readService(ctx, "subprocess"),
    getEndpoint: () => actionServer?.endpoint,
    pwshPathOverride: config.pwshPath,
    onStatusChange: (status) => {
      if (status.status === "error" && status.lastError !== void 0) logger.warn(`helper status error: ${status.lastError}`);
    }
  });
  deps.helper = helperManager;
  let disposed = false;
  const start = async () => {
    try {
      await actionServer?.start();
    } catch (error) {
      logger.error(`action server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (disposed) return;
    try {
      await helperManager?.start();
    } catch (error) {
      logger.error(`helper failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    ctx.inject?.(["webServer"], (scoped) => {
      const webServer = readService(scoped, "webServer") ?? scoped.webServer;
      if (webServer === void 0) {
        logger.warn("webServer service is unavailable: the settings page cannot reach the host");
        return;
      }
      const handler = createSettingsHandler(deps);
      const register = () => webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler });
      const effect = scoped.effect ?? ctx.effect;
      if (effect !== void 0) effect(register, "selection-assistant: settings routes");
      else register();
    });
  } catch (error) {
    logger.error(`cannot register settings routes: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lifecycle = () => {
    void start();
    return () => {
      disposed = true;
      void helperManager?.dispose();
      void actionServer?.close();
      logger.info("selection-assistant unloaded");
    };
  };
  if (ctx.effect !== void 0) ctx.effect(lifecycle, "selection-assistant: helper lifecycle");
  else lifecycle();
}
export {
  ActionServer,
  BUNDLE_VERSION,
  HelperManager,
  LlmBridge,
  PREVIEW_TEXT,
  PluginLogger,
  ROUTE_PREFIX,
  SettingsStore,
  apply,
  buildActionPrompt,
  buildState,
  createDefaultSettings,
  createSettingsHandler,
  inject,
  interpretChunk,
  mergePatch,
  name,
  sanitizeSettings,
  settingsRoutePaths,
  toLlmError
};
//# sourceMappingURL=index.js.map
