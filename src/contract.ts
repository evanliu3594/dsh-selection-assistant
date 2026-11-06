/**
 * Shared contract between the Host half, the browser settings page and the
 * native helper processes (Windows PowerShell and macOS Swift). Types only —
 * no Node, no DOM imports, so both halves can import this module.
 *
 * The Host half serializes these shapes for the helper and the settings page;
 * keep both ends in sync when a field changes.
 */

/** The user-facing trigger mode. `ctrl` matches the requested behavior: select, then hold Ctrl. */
export type TriggerMode = 'selection' | 'ctrl' | 'shortcut'

/** What an action does when clicked. */
export type ActionKind = 'llm' | 'search' | 'copy'

/** How an action derives its model instruction. */
export type ActionPreset = 'translate' | 'explain' | 'summarize' | 'optimize' | 'custom'

/** Icon keys; both the toolbar and the settings page resolve them. */
export type ActionIcon = 'translate' | 'explain' | 'summarize' | 'search' | 'copy' | 'optimize' | 'sparkle'

/** App filter posture. */
export type AppFilterMode = 'off' | 'blacklist' | 'whitelist'

/** Native helper runtime that serves this platform. */
export type HelperKind = 'powershell' | 'swift' | 'none'

/** macOS Accessibility permission as last reported by the helper. */
export type AccessibilityPermission = 'granted' | 'denied' | 'unknown'

/** One configurable toolbar action. */
export interface ActionSettings {
  id: string
  kind: ActionKind
  preset: ActionPreset
  labelZh: string
  labelEn: string
  icon: ActionIcon
  enabled: boolean
  order: number
  /** Empty means "use the built-in preset prompt". */
  systemPrompt: string
  /** `{{text}}` is replaced with the captured selection. Empty means "use the built-in preset prompt". */
  prompt: string
  /** `{{query}}` is replaced with the URL-encoded selection. Only for kind `search`. */
  searchUrl: string
  /** Empty provider/model follows the global model. */
  model: { provider: string; model: string }
}

/** The complete persisted settings document. */
export interface Settings {
  version: 1
  enabled: boolean
  trigger: {
    mode: TriggerMode
    longPressMs: number
    shortcut: string
    captureDelayMs: number
  }
  toolbar: {
    compact: boolean
    maxVisibleActions: number
    scale: number
  }
  result: {
    followToolbar: boolean
    rememberSize: boolean
    autoClose: boolean
    alwaysOnTop: boolean
    opacity: number
    width: number
    height: number
  }
  model: {
    provider: string
    model: string
    reasoningEffort: string
    temperature: number | null
  }
  language: {
    ui: 'zh' | 'en'
    target: string
    fallback: string
  }
  appFilter: {
    mode: AppFilterMode
    processes: string[]
  }
  actions: ActionSettings[]
  advanced: {
    /** Explicit helper executable path; empty means auto-detect/build. */
    helperPath: string
    logLevel: 'error' | 'warn' | 'info' | 'debug'
  }
}

/** Ranges shared by validation and the settings page controls. */
export const LIMITS = {
  longPressMs: { min: 200, max: 1500 },
  captureDelayMs: { min: 50, max: 500 },
  maxVisibleActions: { min: 1, max: 8 },
  scale: { min: 0.85, max: 1.25 },
  opacity: { min: 0.2, max: 1 },
  resultWidth: { min: 300, max: 900 },
  resultHeight: { min: 200, max: 900 },
  maxActions: 20,
} as const

/** Icon keys in toolbar order, reused by the settings page's icon picker. */
export const ACTION_ICONS: readonly ActionIcon[] = [
  'translate',
  'explain',
  'summarize',
  'search',
  'copy',
  'optimize',
  'sparkle',
]

/** Route prefix the host owns on the DSH web server. */
export const ROUTE_PREFIX = '/selection-assistant'

/** Text substituted when the user previews the toolbar from settings. */
export const PREVIEW_TEXT =
  'DeepSeek Harness 是一个本地 AI 智能体运行环境。选中这段文字并长按 Ctrl，就能看到划词助手。'

/** Default system prompts per preset; empty string means "no separate system prompt". */
export const SYSTEM_PROMPTS: Record<ActionPreset, string> = {
  translate: '你是严谨的翻译引擎，只输出译文，不解释、不加引号、不添加原文没有的内容。',
  explain: '',
  summarize: '',
  optimize: '',
  custom: '',
}

/** English defaults, used when the UI locale is `en`. */
export const SYSTEM_PROMPTS_EN: Record<ActionPreset, string> = {
  translate: 'You are a precise translation engine. Output the translation only: no explanation, no quotation marks, no added content.',
  explain: '',
  summarize: '',
  optimize: '',
  custom: '',
}

/** Default prompt templates per preset. `{{text}}` is the captured selection. */
export function defaultPrompt(preset: ActionPreset, language: 'zh' | 'en', target: string, fallback: string): string {
  if (language === 'en') {
    switch (preset) {
      case 'translate':
        return `Translate the following text into ${target}. If it is already in ${target}, translate it into ${fallback}. Preserve paragraphs and list structure.\n\n{{text}}`
      case 'explain':
        return `Explain the following text in plain language: what it means, the context, and the key concepts. Define terms before using them. Keep it under 300 words.\n\n{{text}}`
      case 'summarize':
        return `Summarize the following text in one paragraph of at most 150 words. Keep the key points only.\n\n{{text}}`
      case 'optimize':
        return `Rewrite the following text to be clearer, more accurate and more professional, preserving the original meaning. Output only the rewritten text.\n\n{{text}}`
      default:
        return '{{text}}'
    }
  }
  switch (preset) {
    case 'translate':
      return `把下面的文本翻译成${target}。如果它已经是${target}，就翻译成${fallback}。保留段落与列表结构。只输出译文。\n\n{{text}}`
    case 'explain':
      return `用通俗的语言解释下面这段文字：它是什么意思、背景是什么、关键概念有哪些。术语先给一句定义。不超过 300 字。\n\n{{text}}`
    case 'summarize':
      return `用一段话概括下面文字的核心内容，不超过 150 字，只保留要点，不复述原文。\n\n{{text}}`
    case 'optimize':
      return `润色下面的文字：更通顺、更准确、更专业，保留原意与信息量。只输出润色后的文字。\n\n{{text}}`
    default:
      return '{{text}}'
  }
}

/** Default search URL templates offered by the settings page. */
export const SEARCH_ENGINES: ReadonlyArray<{ id: string; label: string; url: string }> = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q={{query}}' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q={{query}}' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={{query}}' },
  { id: 'baidu', label: '百度', url: 'https://www.baidu.com/s?wd={{query}}' },
]

/** Build the initial settings document. */
export function createDefaultSettings(): Settings {
  const zh = 'zh'
  return {
    version: 1,
    enabled: true,
    trigger: { mode: 'ctrl', longPressMs: 500, shortcut: 'Ctrl+Alt+Q', captureDelayMs: 120 },
    toolbar: { compact: false, maxVisibleActions: 6, scale: 1 },
    result: {
      followToolbar: true,
      rememberSize: true,
      autoClose: true,
      alwaysOnTop: true,
      opacity: 0.96,
      width: 500,
      height: 400,
    },
    model: { provider: '', model: '', reasoningEffort: '', temperature: null },
    language: { ui: zh, target: '简体中文', fallback: 'English' },
    appFilter: { mode: 'off', processes: [] },
    actions: [
      {
        id: 'translate',
        kind: 'llm',
        preset: 'translate',
        labelZh: '翻译',
        labelEn: 'Translate',
        icon: 'translate',
        enabled: true,
        order: 10,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
      {
        id: 'explain',
        kind: 'llm',
        preset: 'explain',
        labelZh: '解释',
        labelEn: 'Explain',
        icon: 'explain',
        enabled: true,
        order: 20,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
      {
        id: 'summarize',
        kind: 'llm',
        preset: 'summarize',
        labelZh: '总结',
        labelEn: 'Summarize',
        icon: 'summarize',
        enabled: true,
        order: 30,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
      {
        id: 'search',
        kind: 'search',
        preset: 'custom',
        labelZh: '搜索',
        labelEn: 'Search',
        icon: 'search',
        enabled: true,
        order: 40,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
      {
        id: 'copy',
        kind: 'copy',
        preset: 'custom',
        labelZh: '复制',
        labelEn: 'Copy',
        icon: 'copy',
        enabled: true,
        order: 50,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
      {
        id: 'optimize',
        kind: 'llm',
        preset: 'optimize',
        labelZh: '润色',
        labelEn: 'Optimize',
        icon: 'optimize',
        enabled: false,
        order: 60,
        systemPrompt: '',
        prompt: '',
        searchUrl: '',
        model: { provider: '', model: '' },
      },
    ],
    advanced: { helperPath: '', logLevel: 'info' },
  }
}

/** Data the Host writes for one helper process launch. */
export interface HelperConfig {
  version: 1
  endpoint: string
  token: string
  dataDir: string
  logPath: string
  locale: 'zh' | 'en'
  trigger: Settings['trigger']
  toolbar: Settings['toolbar']
  result: Settings['result']
  appFilter: Settings['appFilter']
  actions: Array<{ id: string; kind: ActionKind; label: string; icon: ActionIcon; enabled: boolean; order: number; searchUrl: string }>
  debug: boolean
}

/** One-shot command file consumed by the helper. */
export interface HelperCommand {
  id: string
  type: 'preview'
  text: string
}

/** Helper status as seen from the settings page. */
export interface HelperStatus {
  status: 'stopped' | 'starting' | 'running' | 'error'
  pid?: number
  startedAt?: number
  /** Windows interpreter family serving the helper: "PowerShell 7" or "Windows PowerShell 5.1". */
  runtime?: string
  lastError?: string
  restarts: number
}

/** Model option advertised by the Host. */
export interface ModelOption {
  id: string
  name: string
  reasoningEfforts: Array<{ id: string; name: string }>
  defaultReasoningEffort: string
}

/** Provider option advertised by the Host. */
export interface ProviderOption {
  provider: string
  name: string
  models: ModelOption[]
}

/** Full state response. */
export interface StateDto {
  settings: Settings
  helper: HelperStatus
  platform: {
    os: string
    arch: string
    /** Resolved helper executable (pwsh.exe or powershell.exe on Windows, Swift binary on macOS). */
    helper: string
    helperKind: HelperKind
    supported: boolean
    reason: string
    /** Accessibility permission means macOS only; unknown elsewhere. */
    permissions: { accessibility: AccessibilityPermission }
  }
  defaults: { provider: string; model: string; reasoningEffort: string }
  paths: { dataDir: string; log: string }
  version: string
}

/** Error shape for every JSON failure. */
export interface RouteError {
  code: string
  message: string
}

/** Deep-partial patch accepted by POST /settings. */
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends Array<unknown>
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K]
}
