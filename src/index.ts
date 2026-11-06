/**
 * dsh-selection-assistant — Host half.
 *
 * Wires four modules into one plugin row:
 *   settings  — `<dataDir>/settings.json`, edited by the browser settings page
 *   llm       — streams DeepSeek (or any configured route) through `ctx.llm`
 *   helper    — owns the PowerShell 7 + WPF selection helper process
 *   server    — settings routes on the DSH web server + loopback SSE for the helper
 *
 * Every DSH service is optional: a profile without `llm`, `webServer`,
 * `subprocess`, or `agentDefaultModel` still loads the plugin, and the settings
 * page reports the missing capability instead of the plugin throwing.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsStore } from './settings.js'
import { LlmBridge, type DefaultModelServiceLike, type LlmServiceLike } from './llm.js'
import { BUNDLE_VERSION, HelperManager, openAccessibilitySettings, type SubprocessServiceLike } from './helper.js'
import { ActionServer, createSettingsHandler, type ServerDeps, type WebServerLike } from './server.js'
import { PluginLogger } from './log.js'
import { ROUTE_PREFIX, type HelperStatus, type Settings } from './contract.js'

/** Loader identity for this plugin row. */
export const name = 'selection-assistant'

/** No hard service dependency; optional services are read with `ctx.get`. */
export const inject: string[] = []

/** Row config accepted from the profile patch. */
export interface Config {
  /** Overrides `<DSH_HOME>/selection-assistant`. */
  dataDir?: string
  /** Fallback helper executable path; an explicit setting still wins. */
  helperPath?: string
  /** Pre-0.2 name of {@link helperPath}; kept for existing profiles. */
  pwshPath?: string
}

/** Structural view of the Cordis host context this plugin uses. */
interface PluginContextLike {
  effect?: (callback: () => void | (() => void), label?: string) => unknown
  inject?: (names: string[], callback: (scoped: PluginContextLike) => void) => unknown
  get?: (service: string) => unknown
  logger?: (name: string) => { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void; debug: (message: string) => void }
  webServer?: WebServerLike
}

/** Resolve DSH_HOME the same way the runtime does. */
function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Read one service without letting an odd profile throw inside a getter. */
function readService<T>(ctx: PluginContextLike, key: string): T | undefined {
  try {
    return ctx.get?.(key) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Host plugin body.
 * @param rawCtx - the plugin's Cordis context.
 * @param config - raw row config from `cordis.patch.yml`.
 */
export function apply(rawCtx: unknown, config: Config = {}): void {
  const ctx = (rawCtx ?? {}) as PluginContextLike
  const dataDir = config.dataDir?.trim() ?? ''
  const resolvedDataDir = dataDir !== '' ? dataDir : join(resolveDshHome(), 'selection-assistant')

  let hostLogger: ReturnType<NonNullable<PluginContextLike['logger']>> | undefined
  try {
    hostLogger = ctx.logger?.('selection-assistant')
  } catch {
    hostLogger = undefined
  }

  const settings = new SettingsStore(resolvedDataDir)
  const logger = new PluginLogger(resolvedDataDir, settings.get().advanced.logLevel, hostLogger)
  logger.info(`selection-assistant ${BUNDLE_VERSION} loading (dataDir=${resolvedDataDir}, platform=${process.platform})`)

  const llm = new LlmBridge(
    () => readService<LlmServiceLike>(ctx, 'llm'),
    () => readService<DefaultModelServiceLike>(ctx, 'agentDefaultModel'),
  )

  let actionServer: ActionServer | undefined
  let helperManager: HelperManager | undefined

  const deps: ServerDeps = {
    dataDir: resolvedDataDir,
    logPath: join(resolvedDataDir, 'helper.log'),
    pluginLogPath: logger.path,
    version: BUNDLE_VERSION,
    settings,
    llm,
    helper: undefined as unknown as HelperManager,
    logger,
    helperPath: () => helperManager?.executablePath ?? '',
    helperKind: () => helperManager?.kind ?? 'none',
    platformSupported: () => helperManager?.kind !== 'none' && (helperManager?.scriptPresent ?? false),
    platformReason: () => {
      if (helperManager?.kind === 'powershell') {
        if (helperManager.scriptPresent !== true) return '插件包内缺少 helper/SelectionAssistant.ps1。'
        return ''
      }
      if (helperManager?.kind === 'swift') {
        if (helperManager.scriptPresent !== true) return '插件包内缺少 helper/macos/Sources。'
        return ''
      }
      return '划词助手支持 Windows 10/11 与 macOS 13.1 及以上。'
    },
    openPermissions: () => openAccessibilitySettings(),
    onSettingsSaved: (next: Settings) => {
      logger.setLevel(next.advanced.logLevel)
      llm.invalidate()
      helperManager?.applySettings()
    },
  }

  actionServer = new ActionServer(deps)
  helperManager = new HelperManager({
    dataDir: resolvedDataDir,
    logPath: deps.logPath,
    logger,
    getSettings: () => settings.get(),
    getSubprocess: () => readService<SubprocessServiceLike>(ctx, 'subprocess'),
    getEndpoint: () => actionServer?.endpoint,
    helperPathOverride: config.helperPath ?? config.pwshPath,
    onStatusChange: (status: HelperStatus) => {
      if (status.status === 'error' && status.lastError !== undefined) logger.warn(`helper status error: ${status.lastError}`)
    },
  })
  deps.helper = helperManager

  let disposed = false
  const start = async (): Promise<void> => {
    try {
      await actionServer?.start()
    } catch (error) {
      logger.error(`action server failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (disposed) return
    try {
      await helperManager?.start()
    } catch (error) {
      logger.error(`helper failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Settings route registration: only when the profile actually mounts a web server.
  try {
    ctx.inject?.(['webServer'], scoped => {
      const webServer = readService<WebServerLike>(scoped, 'webServer') ?? scoped.webServer
      if (webServer === undefined) {
        logger.warn('webServer service is unavailable: the settings page cannot reach the host')
        return
      }
      const handler = createSettingsHandler(deps)
      const register = (): (() => void) => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      const effect = scoped.effect ?? ctx.effect
      if (effect !== undefined) effect(register, 'selection-assistant: settings routes')
      else register()
    })
  } catch (error) {
    logger.error(`cannot register settings routes: ${error instanceof Error ? error.message : String(error)}`)
  }

  // One lifecycle effect owns the helper process and the loopback server.
  const lifecycle = (): (() => void) => {
    void start()
    return () => {
      disposed = true
      void helperManager?.dispose()
      void actionServer?.close()
      logger.info('selection-assistant unloaded')
    }
  }
  if (ctx.effect !== undefined) ctx.effect(lifecycle, 'selection-assistant: helper lifecycle')
  else lifecycle()
}

// ---------------------------------------------------------------------------
// Test surface: the verification script imports these through the built bundle
// so the host half can be checked without a running DSH profile.
// ---------------------------------------------------------------------------

export { SettingsStore, sanitizeSettings, mergePatch } from './settings.js'
export { createDefaultSettings } from './contract.js'
export { LlmBridge, buildActionPrompt, interpretChunk, toLlmError } from './llm.js'
export { HelperManager, BUNDLE_VERSION, helperKindForPlatform, openAccessibilitySettings } from './helper.js'
export { ActionServer, buildState, createSettingsHandler, settingsRoutePaths } from './server.js'
export { PluginLogger } from './log.js'
export { PREVIEW_TEXT, ROUTE_PREFIX } from './contract.js'
export type { Settings, StateDto, HelperStatus } from './contract.js'
export type { ServerDeps } from './server.js'
