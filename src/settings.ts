/**
 * Persisted settings for the selection assistant.
 *
 * The row config stays tiny on purpose; every user-facing option lives in
 * `<dataDir>/settings.json`. The settings page edits that file through the host
 * routes, and a save restarts only the helper process — never the plugin or the
 * Host. Writes are atomic (tmp + rename) and every value is sanitized on both
 * load and save, so a hand-edited file cannot crash the helper.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTION_ICONS,
  LIMITS,
  SEARCH_ENGINES,
  createDefaultSettings,
  type ActionKind,
  type ActionPreset,
  type ActionSettings,
  type AppFilterMode,
  type Settings,
  type SettingsPatch,
  type TriggerMode,
} from './contract.js'
import { normalizeLanguageCode } from './lang.js'

/** Settings document version this module understands. */
const SETTINGS_VERSION = 1

/** Settings file name inside the data directory. */
const SETTINGS_FILE = 'settings.json'

/** Clamp a number into an inclusive range, falling back when not finite. */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Pick one of the allowed literals. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** Read a trimmed string with a fallback. */
function text(value: unknown, fallback: string, maxLength = 2000): string {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/** Read a string array (executable names). */
function textList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge: objects merge, arrays and scalars replace. */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch === undefined ? base : patch
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = next[key]
    next[key] = isRecord(current) && isRecord(value) ? mergePatch(current, value) : value
  }
  return next
}

/** Icon keys accepted from a hand-edited settings file. */
const ICONS = ACTION_ICONS

/** Presets accepted from a hand-edited settings file. */
const PRESETS: readonly ActionPreset[] = ['translate', 'explain', 'summarize', 'optimize', 'custom']

/** Action kinds accepted from a hand-edited settings file. */
const KINDS: readonly ActionKind[] = ['llm', 'search', 'copy']

/** Validate and sanitize one action entry, or reject it. */
function sanitizeAction(raw: unknown, index: number): ActionSettings | undefined {
  if (!isRecord(raw)) return undefined
  const id = text(raw.id, '', 64)
  if (id === '' || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  const kind = oneOf<ActionKind>(raw.kind, KINDS, 'llm')
  const preset = oneOf<ActionPreset>(raw.preset, PRESETS, 'custom')
  const icon = oneOf(raw.icon, ICONS, 'sparkle')
  const model = isRecord(raw.model) ? raw.model : {}
  return {
    id,
    kind,
    preset,
    labelZh: text(raw.labelZh, id, 40),
    labelEn: text(raw.labelEn, id, 40),
    icon,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    order: clampNumber(raw.order, (index + 1) * 10, 0, 10_000),
    systemPrompt: text(raw.systemPrompt, '', 8000),
    prompt: text(raw.prompt, '', 8000),
    searchUrl: text(raw.searchUrl, '', 2000),
    model: {
      provider: text(model.provider, '', 120),
      model: text(model.model, '', 120),
    },
  }
}

/** Sanitize the actions array: unique ids, non-empty, stable order. */
function sanitizeActions(value: unknown): ActionSettings[] {
  const list = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const actions: ActionSettings[] = []
  for (const [index, entry] of list.entries()) {
    if (actions.length >= LIMITS.maxActions) break
    const action = sanitizeAction(entry, index)
    if (action === undefined || seen.has(action.id)) continue
    seen.add(action.id)
    actions.push(action)
  }
  if (actions.length === 0) return createDefaultSettings().actions
  return actions.sort((left, right) => left.order - right.order)
}

/** Sanitize a whole settings document into the shape the rest of the plugin expects. */
export function sanitizeSettings(raw: unknown): Settings {
  const defaults = createDefaultSettings()
  const value = isRecord(raw) ? raw : {}
  const trigger = isRecord(value.trigger) ? value.trigger : {}
  const toolbar = isRecord(value.toolbar) ? value.toolbar : {}
  const result = isRecord(value.result) ? value.result : {}
  const model = isRecord(value.model) ? value.model : {}
  const language = isRecord(value.language) ? value.language : {}
  const appFilter = isRecord(value.appFilter) ? value.appFilter : {}
  const advanced = isRecord(value.advanced) ? value.advanced : {}
  // 0.2 renamed pwshPath to helperPath. Honor the old key only when the new one
  // is absent, so clearing helperPath does not resurrect a stale PowerShell path.
  const helperPathRaw = 'helperPath' in advanced ? advanced.helperPath : advanced.pwshPath
  return {
    version: SETTINGS_VERSION,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    trigger: {
      mode: oneOf<TriggerMode>(trigger.mode, ['selection', 'ctrl', 'shortcut'], defaults.trigger.mode),
      longPressMs: clampNumber(trigger.longPressMs, defaults.trigger.longPressMs, LIMITS.longPressMs.min, LIMITS.longPressMs.max),
      shortcut: text(trigger.shortcut, defaults.trigger.shortcut, 60),
      captureDelayMs: clampNumber(
        trigger.captureDelayMs,
        defaults.trigger.captureDelayMs,
        LIMITS.captureDelayMs.min,
        LIMITS.captureDelayMs.max,
      ),
    },
    toolbar: {
      compact: typeof toolbar.compact === 'boolean' ? toolbar.compact : defaults.toolbar.compact,
      maxVisibleActions: clampNumber(
        toolbar.maxVisibleActions,
        defaults.toolbar.maxVisibleActions,
        LIMITS.maxVisibleActions.min,
        LIMITS.maxVisibleActions.max,
      ),
      scale: clampNumber(toolbar.scale, defaults.toolbar.scale, LIMITS.scale.min, LIMITS.scale.max),
    },
    result: {
      followToolbar: typeof result.followToolbar === 'boolean' ? result.followToolbar : defaults.result.followToolbar,
      rememberSize: typeof result.rememberSize === 'boolean' ? result.rememberSize : defaults.result.rememberSize,
      autoClose: typeof result.autoClose === 'boolean' ? result.autoClose : defaults.result.autoClose,
      alwaysOnTop: typeof result.alwaysOnTop === 'boolean' ? result.alwaysOnTop : defaults.result.alwaysOnTop,
      opacity: clampNumber(result.opacity, defaults.result.opacity, LIMITS.opacity.min, LIMITS.opacity.max),
      width: clampNumber(result.width, defaults.result.width, LIMITS.resultWidth.min, LIMITS.resultWidth.max),
      height: clampNumber(result.height, defaults.result.height, LIMITS.resultHeight.min, LIMITS.resultHeight.max),
    },
    model: {
      provider: text(model.provider, defaults.model.provider, 120),
      model: text(model.model, defaults.model.model, 120),
      reasoningEffort: text(model.reasoningEffort, defaults.model.reasoningEffort, 60),
      temperature:
        model.temperature === null || model.temperature === undefined
          ? null
          : clampNumber(model.temperature, 1, 0, 2),
    },
    language: {
      ui: oneOf(language.ui, ['zh', 'en'], defaults.language.ui),
      // 0.2.3 stores language codes; pre-0.2.3 documents held display names
      // ("简体中文", "English"), so migrate them and fall back to the defaults.
      target: normalizeLanguageCode(language.target, defaults.language.target),
      fallback: normalizeLanguageCode(language.fallback, defaults.language.fallback),
    },
    appFilter: {
      mode: oneOf<AppFilterMode>(appFilter.mode, ['off', 'blacklist', 'whitelist'], defaults.appFilter.mode),
      processes: textList(appFilter.processes, defaults.appFilter.processes).slice(0, 100),
    },
    actions: sanitizeActions(value.actions),
    advanced: {
      helperPath: text(helperPathRaw, defaults.advanced.helperPath, 500),
      logLevel: oneOf(advanced.logLevel, ['error', 'warn', 'info', 'debug'], defaults.advanced.logLevel),
    },
  }
}

/** Loaded settings plus their persistence path. */
export class SettingsStore {
  private readonly file: string
  private settings: Settings
  private readonly listeners = new Set<(next: Settings) => void>()

  /**
   * @param dataDir - plugin data directory; created when missing.
   */
  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, SETTINGS_FILE)
    this.settings = this.read()
  }

  /** Settings file path. */
  get path(): string {
    return this.file
  }

  /** Current settings snapshot (treat as immutable). */
  get(): Settings {
    return this.settings
  }

  /** Read the file, falling back to defaults; a corrupt file is preserved as `.bak`. */
  private read(): Settings {
    if (!existsSync(this.file)) {
      const defaults = createDefaultSettings()
      this.write(defaults)
      return defaults
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return sanitizeSettings(raw)
    } catch {
      try {
        copyFileSync(this.file, `${this.file}.bak`)
      } catch {
        // Keep going: defaults are still usable.
      }
      const defaults = createDefaultSettings()
      this.write(defaults)
      return defaults
    }
  }

  /** Atomic write of one full document. */
  private write(settings: Settings): void {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.file)
  }

  /** Replace the whole document (used by tests and resets). */
  replace(settings: Settings): Settings {
    this.settings = sanitizeSettings(settings)
    this.write(this.settings)
    for (const listener of this.listeners) listener(this.settings)
    return this.settings
  }

  /** Apply a deep-merged patch, sanitize, persist, and notify listeners. */
  patch(patch: SettingsPatch): Settings {
    const merged = mergePatch(this.settings, patch)
    const next = sanitizeSettings(merged)
    this.settings = next
    this.write(next)
    for (const listener of this.listeners) listener(next)
    return next
  }

  /** Subscribe to saved documents; the disposer detaches. */
  onChange(listener: (next: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** Default search URL when an action leaves `searchUrl` empty. */
export function defaultSearchUrl(): string {
  return SEARCH_ENGINES[0]?.url ?? 'https://www.google.com/search?q={{query}}'
}

/** Absolute path of the settings file in one data directory. */
export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE)
}
