/**
 * Lifecycle manager for the Windows helper process (`helper/SelectionAssistant.ps1`).
 *
 * The helper is the only part of the feature that touches the operating system:
 * global hooks, the clipboard, and the floating WPF windows. This module owns
 * launching it with the right config, restarting it on crash or settings change,
 * and tearing it down when the plugin unloads.
 *
 * The Host process is not sandboxed like a shell tool, so `node:child_process`
 * is used directly. stdin stays open as a parent watchdog: the helper exits as
 * soon as this side disconnects.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { HelperCommand, HelperConfig, HelperStatus, Settings } from './contract.js'
import type { PluginLogger } from './log.js'

/** Package root resolved from this module's location (works for src/ and lib/). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Relative path of the PowerShell entry point. */
const HELPER_SCRIPT = join(PACKAGE_ROOT, 'helper', 'SelectionAssistant.ps1')

/** How many crashed launches are retried before giving up until a manual restart. */
const MAX_AUTO_RESTARTS = 5

/** Delay before an automatic restart, multiplied by the attempt number. */
const RESTART_BASE_MS = 1200

/** Bundle version fallback when package.json cannot be read at runtime. */
function readVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const version = (raw as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

/** Bundle version reported by the settings page. */
export const BUNDLE_VERSION = readVersion()

/** Structural view of `ctx.subprocess` (optional; no DSH import). */
export interface SubprocessServiceLike {
  resolveExecutable?(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
}

/** Where the helper can report back to. */
export interface HelperEndpoint {
  url: string
  token: string
}

/** Dependencies injected by the plugin entry. */
export interface HelperManagerOptions {
  dataDir: string
  logPath: string
  logger: PluginLogger
  getSettings: () => Settings
  getSubprocess: () => SubprocessServiceLike | undefined
  getEndpoint: () => HelperEndpoint | undefined
  /** Row-config override for `pwsh.exe`; an explicit user setting still wins. */
  pwshPathOverride?: string
  onStatusChange?: (status: HelperStatus) => void
}

/** Find `pwsh.exe` on PATH and in the usual installation directories. */
function findPwshOnDisk(explicit: string): string | undefined {
  const candidates: string[] = []
  if (explicit.trim() !== '') candidates.push(explicit.trim())
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(';')) {
    if (directory.trim() === '') continue
    candidates.push(join(directory.trim(), 'pwsh.exe'))
  }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData !== '') candidates.push(join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  const userProfile = process.env.USERPROFILE ?? ''
  if (userProfile !== '') candidates.push(join(userProfile, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  if (process.env.ProgramFiles !== undefined) candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  if (process.env.ProgramFiles !== undefined) candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7-preview', 'pwsh.exe'))
  if (process.env.ProgramData !== undefined) candidates.push(join(process.env.ProgramData, 'chocolatey', 'bin', 'pwsh.exe'))
  let windowsAppsGuess: string | undefined
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Ignore unreadable PATH entries.
    }
    // The DSH host process cannot always stat `WindowsApps` (ACL/sandbox), but
    // CreateProcess can still launch an app-execution alias, so keep the first
    // such candidate as a best-effort guess.
    if (windowsAppsGuess === undefined && /WindowsApps[\\/](?:[^\\/]+[\\/])?pwsh\.exe$/i.test(candidate)) {
      windowsAppsGuess = candidate
    }
  }
  return windowsAppsGuess
}

/** Reject the Windows PowerShell 5.1 binary: the helper script needs PowerShell 7. */
function isLegacyPowerShell(path: string): boolean {
  return basename(path).toLowerCase() === 'powershell.exe'
}

/** Helper process manager. */
export class HelperManager {
  private readonly options: HelperManagerOptions
  private readonly stateFile: string
  private readonly configFile: string
  private readonly commandFile: string
  private child: ChildProcess | undefined
  private status: HelperStatus = { status: 'stopped', restarts: 0 }
  private intentionalStop = false
  private restartTimer: NodeJS.Timeout | undefined
  private updateTimer: NodeJS.Timeout | undefined
  private readyTimer: NodeJS.Timeout | undefined
  private disposed = false
  private resolvedPwsh: string | undefined

  constructor(options: HelperManagerOptions) {
    this.options = options
    mkdirSync(options.dataDir, { recursive: true })
    this.stateFile = join(options.dataDir, 'helper-state.json')
    this.configFile = join(options.dataDir, 'helper-config.json')
    this.commandFile = join(options.dataDir, 'command.json')
  }

  /** Current status snapshot. */
  getStatus(): HelperStatus {
    return this.status
  }

  /** Absolute path of the helper entry point, for the settings page diagnostics. */
  get scriptPath(): string {
    return HELPER_SCRIPT
  }

  /** Whether the helper entry point ships with the package. */
  get scriptPresent(): boolean {
    return existsSync(HELPER_SCRIPT)
  }

  /** Publish a status change to listeners. */
  private publish(patch: Partial<HelperStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.onStatusChange?.(this.status)
  }

  /** Resolved PowerShell path, once a launch attempt resolved one. */
  get pwshPath(): string {
    return this.resolvedPwsh ?? ''
  }

  /** Resolve PowerShell candidates in priority order; the first that launches wins. */
  async resolvePwshCandidates(): Promise<string[]> {
    const candidates: string[] = []
    const push = (candidate: string): void => {
      const trimmed = candidate.trim()
      if (trimmed === '' || candidates.includes(trimmed) || isLegacyPowerShell(trimmed)) return
      candidates.push(trimmed)
    }
    const settings = this.options.getSettings()
    const configured = settings.advanced.pwshPath.trim()
    const override = (this.options.pwshPathOverride ?? '').trim()
    for (const explicit of [configured, override]) {
      if (explicit === '' || isLegacyPowerShell(explicit)) continue
      try {
        const resolved = await this.options.getSubprocess()?.resolveExecutable?.(explicit)
        if (resolved !== undefined && resolved !== '') push(resolved)
      } catch {
        // A resolver failure must not block an otherwise valid absolute path.
      }
      // Do not gate on existsSync: the host process cannot stat every WindowsApp
      // alias, and spawn reports a precise error when the path is truly wrong.
      push(explicit)
    }
    try {
      const resolved = await this.options.getSubprocess()?.resolveExecutable?.('pwsh')
      if (resolved !== undefined && resolved !== '') push(resolved)
    } catch {
      // Not every profile resolves executables; the PATH scan below is enough.
    }
    const found = findPwshOnDisk('')
    if (found !== undefined) push(found)
    // Last resort: bare name resolved by CreateProcess through the host PATH.
    push('pwsh')
    return candidates
  }

  /** First candidate path, for diagnostics and the settings page. */
  async resolvePwsh(): Promise<string | undefined> {
    return (await this.resolvePwshCandidates())[0]
  }

  /** Write the helper config file atomically. */
  private writeConfig(endpoint: HelperEndpoint, pwshPath: string): HelperConfig {
    const settings = this.options.getSettings()
    const config: HelperConfig = {
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
      actions: settings.actions
        .filter(action => action.enabled)
        .sort((left, right) => left.order - right.order)
        .map(action => ({
          id: action.id,
          kind: action.kind,
          label: settings.language.ui === 'en' ? action.labelEn || action.labelZh : action.labelZh || action.labelEn,
          icon: action.icon,
          enabled: action.enabled,
          order: action.order,
          searchUrl: action.searchUrl,
        })),
      debug: settings.advanced.logLevel === 'debug',
    }
    const temporary = `${this.configFile}.tmp`
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.configFile)
    this.options.logger.info(`helper config written (${String(config.actions.length)} action(s), pwsh=${pwshPath})`)
    return config
  }

  /** Remembered result size overrides the configured default when enabled. */
  private rememberedResult(settings: Settings): Settings['result'] {
    if (!settings.result.rememberSize) return { ...settings.result }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const state = raw as { resultWidth?: unknown; resultHeight?: unknown }
      const width = typeof state.resultWidth === 'number' ? state.resultWidth : settings.result.width
      const height = typeof state.resultHeight === 'number' ? state.resultHeight : settings.result.height
      return { ...settings.result, width, height }
    } catch {
      return { ...settings.result }
    }
  }

  /** Append helper stdout/stderr lines to the helper log. */
  private wireOutput(stream: NodeJS.ReadableStream | null, label: string): void {
    if (stream === null) return
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 8000) buffer = buffer.slice(-8000)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') this.options.logger.info(`[helper:${label}] ${line}`)
      }
    })
    stream.on('error', () => {
      // Stream teardown races with process exit; nothing to report.
    })
  }

  /** Wire one spawned child: output capture, exit handling, and the ready watchdog. */
  private attachChild(child: ChildProcess, pwsh: string): void {
    this.child = child
    this.resolvedPwsh = pwsh
    this.wireOutput(child.stdout, 'out')
    this.wireOutput(child.stderr, 'err')
    child.once('error', error => {
      this.options.logger.error(`helper process error: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      this.clearReadyTimer()
      this.child = undefined
      if (this.disposed || this.intentionalStop) {
        this.publish({ status: 'stopped', pid: undefined })
        return
      }
      const detail = signal !== null ? `signal=${signal}` : `code=${String(code ?? 'null')}`
      this.options.logger.error(`helper exited unexpectedly (${detail})`)
      this.publish({ status: 'error', lastError: `助手进程意外退出（${detail}）。`, pid: undefined })
      this.scheduleRestart()
    })
    this.publish({ status: 'starting', pid: child.pid, startedAt: Date.now() })
    this.armReadyTimer()
    this.options.logger.info(`helper launched with ${pwsh} (pid=${String(child.pid ?? '')})`)
  }

  /** Spawn one candidate and resolve once the OS reports success. */
  private spawnCandidate(pwsh: string, endpoint: HelperEndpoint): Promise<ChildProcess> {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT, '-ConfigPath', this.configFile]
    // Write the config before spawning: the helper reads it during startup.
    this.writeConfig(endpoint, pwsh)
    return new Promise<ChildProcess>((resolveSpawn, rejectSpawn) => {
      let child: ChildProcess
      try {
        child = spawn(pwsh, args, {
          cwd: this.options.dataDir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, DSH_SELECTION_ASSISTANT_DATA: this.options.dataDir },
        })
      } catch (error) {
        rejectSpawn(error)
        return
      }
      const onSpawn = (): void => {
        child.off('error', onError)
        resolveSpawn(child)
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        rejectSpawn(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  /** Arm the watchdog that reports a helper which never announces readiness. */
  private armReadyTimer(): void {
    this.clearReadyTimer()
    this.readyTimer = setTimeout(() => {
      if (this.status.status === 'starting') {
        this.options.logger.warn('helper did not report ready within 15s')
        this.publish({ status: 'error', lastError: '助手进程启动后 15 秒内没有报告就绪，请查看日志。' })
      }
    }, 15_000)
    this.readyTimer.unref?.()
  }

  /** Start the helper when the feature is enabled and the platform supports it. */
  async start(): Promise<void> {
    if (this.disposed) return
    const settings = this.options.getSettings()
    if (!settings.enabled) {
      this.publish({ status: 'stopped', lastError: '' })
      return
    }
    if (process.platform !== 'win32') {
      this.publish({ status: 'error', lastError: '划词助手目前只支持 Windows。' })
      return
    }
    if (!this.scriptPresent) {
      this.publish({ status: 'error', lastError: `找不到助手脚本：${HELPER_SCRIPT}` })
      return
    }
    const endpoint = this.options.getEndpoint()
    if (endpoint === undefined) {
      this.publish({ status: 'error', lastError: '助手通信端口尚未就绪。' })
      return
    }
    this.intentionalStop = false
    this.publish({ status: 'starting', lastError: '' })
    const candidates = await this.resolvePwshCandidates()
    const failures: string[] = []
    for (const pwsh of candidates) {
      try {
        const child = await this.spawnCandidate(pwsh, endpoint)
        this.attachChild(child, pwsh)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${pwsh}: ${message}`)
        this.options.logger.warn(`helper spawn candidate failed (${pwsh}): ${message}`)
      }
    }
    this.publish({
      status: 'error',
      lastError: `无法启动助手进程。已尝试：${failures.join('；')}。请在设置 → 高级 → pwsh 路径里填写 pwsh.exe 的完整路径。`,
    })
  }

  /** The helper announced readiness. */
  markReady(): void {
    this.clearReadyTimer()
    this.publish({ status: 'running', lastError: '', startedAt: this.status.startedAt ?? Date.now() })
    this.options.logger.info(`helper ready (pid=${String(this.status.pid ?? '')})`)
  }

  /** The helper reported a fatal error. */
  markError(message: string): void {
    this.clearReadyTimer()
    this.publish({ status: 'error', lastError: message })
  }

  /** One automatic restart after an unexpected exit, bounded by MAX_AUTO_RESTARTS. */
  private scheduleRestart(): void {
    if (this.disposed) return
    if (this.status.restarts >= MAX_AUTO_RESTARTS) {
      this.options.logger.error('helper restart budget exhausted; waiting for a manual restart')
      return
    }
    const attempt = this.status.restarts + 1
    this.publish({ status: 'starting', restarts: attempt })
    this.restartTimer = setTimeout(() => {
      void this.start()
    }, RESTART_BASE_MS * attempt)
    this.restartTimer.unref?.()
  }

  /** Stop the helper; the next start is clean. */
  async stop(): Promise<void> {
    this.intentionalStop = true
    this.clearReadyTimer()
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.publish({ status: 'stopped', pid: undefined })
      return
    }
    try {
      child.stdin?.end()
    } catch {
      // stdin may already be closed.
    }
    await new Promise<void>(resolveStop => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Process already gone.
        }
        resolveStop()
      }, 2500)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolveStop()
      })
    })
    this.publish({ status: 'stopped', pid: undefined, lastError: '' })
  }

  /** Restart on demand (settings button or settings change). */
  async restart(): Promise<void> {
    await this.stop()
    this.publish({ status: 'starting', restarts: 0, lastError: '' })
    await this.start()
  }

  /** Apply new settings: rewrite config and restart when the helper is live. */
  applySettings(): void {
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined
      const settings = this.options.getSettings()
      if (!settings.enabled) {
        void this.stop()
        return
      }
      const endpoint = this.options.getEndpoint()
      if (endpoint === undefined) return
      if (this.child !== undefined) {
        void this.restart()
      } else {
        void this.start()
      }
    }, 350)
    this.updateTimer.unref?.()
  }

  /** Ask the helper to show a preview toolbar and result window. */
  preview(text: string): void {
    if (this.child === undefined) throw new Error('助手进程未在运行，请先启动。')
    const command: HelperCommand = { id: randomUUID(), type: 'preview', text }
    const temporary = `${this.commandFile}.tmp`
    writeFileSync(temporary, `${JSON.stringify(command, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.commandFile)
    this.options.logger.info('preview command written')
  }

  /** Kill the helper and clear every timer; safe to call twice. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
    await this.stop()
  }

  /** Clear the readiness watchdog timer. */
  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) {
      clearTimeout(this.readyTimer)
      this.readyTimer = undefined
    }
  }
}
