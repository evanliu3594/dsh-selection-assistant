/**
 * Lifecycle manager for the native selection-helper process.
 *
 * Two runtimes are supported from one manager:
 *   - Windows: PowerShell 7 runs `helper/SelectionAssistant.ps1` (WPF UI).
 *   - macOS:   a statically linked Swift binary `helper/macos/bin/SelectionAssistant`
 *              is compiled on demand from `helper/macos/Sources` (AppKit UI).
 *
 * The helper is the only part of the feature that touches the operating system:
 * global hooks, the clipboard, and the floating windows. This module owns
 * launching it with the right config, restarting it on crash or settings change,
 * and tearing it down when the plugin unloads.
 *
 * The Host process is not sandboxed like a shell tool, so `node:child_process`
 * is used directly. stdin stays open as a parent watchdog: the helper exits as
 * soon as this side disconnects.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type {
  AccessibilityPermission,
  HelperCommand,
  HelperConfig,
  HelperKind,
  HelperStatus,
  Settings,
} from './contract.js'
import type { PluginLogger } from './log.js'

/** Package root resolved from this module's location (works for src/ and lib/). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Relative path of the Windows PowerShell entry point. */
const HELPER_WIN_SCRIPT = join(PACKAGE_ROOT, 'helper', 'SelectionAssistant.ps1')

/** macOS Swift sources; their presence makes the package installable on macOS. */
const HELPER_MAC_SOURCES = join(PACKAGE_ROOT, 'helper', 'macos', 'Sources')

/** App bundle launched through LaunchServices so TCC attributes the grant to it. */
const HELPER_MAC_APP = join(PACKAGE_ROOT, 'helper', 'macos', 'bin', 'SelectionAssistant.app')

/** Inner executable of the macOS app bundle. */
const HELPER_MAC_BIN = join(HELPER_MAC_APP, 'Contents', 'MacOS', 'SelectionAssistant')

/** Bundle id the macOS app reads its launch preferences from. */
const MAC_HELPER_BUNDLE_ID = 'com.evanliu3594.dsh-selection-assistant.helper'

/** Build script that compiles the Swift helper with swiftc. */
const MAC_BUILD_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'build-macos-helper.sh')

/** How many crashed launches are retried before giving up until a manual restart. */
const MAX_AUTO_RESTARTS = 5

/** Delay before an automatic restart, multiplied by the attempt number. */
const RESTART_BASE_MS = 1200

/** How long a spawned helper may take to report readiness. */
const READY_TIMEOUT_MS = 15_000

/** Upper bound for the first-run Swift build. */
const MAC_BUILD_TIMEOUT_MS = 240_000

/** Bundle version fallback when package.json cannot be read at runtime. */
function readVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const version = (raw as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.2.1'
  } catch {
    return '0.2.1'
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
  /** Row-config override for the helper executable; an explicit user setting still wins. */
  helperPathOverride?: string
  onStatusChange?: (status: HelperStatus) => void
}

/** Accessibility permission as tracked from helper status frames. */
export interface HelperPermissionState {
  accessibility: AccessibilityPermission
}

/** Native runtime this platform uses. */
export function helperKindForPlatform(platform: NodeJS.Platform = process.platform): HelperKind {
  if (platform === 'win32') return 'powershell'
  if (platform === 'darwin') return 'swift'
  return 'none'
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

/** Promise-based delay used by the pid lifecycle helpers. */
function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms)
  })
}

/** Newest modification time below a directory, or 0 when it cannot be read. */
function newestMtime(directory: string): number {
  let newest = 0
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path))
      continue
    }
    try {
      newest = Math.max(newest, statSync(path).mtimeMs)
    } catch {
      // A file that vanished between readdir and stat is simply ignored.
    }
  }
  return newest
}

/** Open the macOS Accessibility pane; the helper cannot grant TCC permission itself. */
export async function openAccessibilitySettings(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('只有 macOS 需要辅助功能权限。')
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], {
      stdio: 'ignore',
    })
    child.once('error', error => {
      rejectOpen(new Error(`无法打开系统设置：${error.message}`))
    })
    child.once('exit', code => {
      if (code === 0) resolveOpen()
      else rejectOpen(new Error(`打开系统设置失败（code=${String(code ?? 'null')}）。`))
    })
  })
}

/** Helper process manager. */
export class HelperManager {
  private readonly options: HelperManagerOptions
  private readonly stateFile: string
  private readonly configFile: string
  private readonly commandFile: string
  private child: ChildProcess | undefined
  private status: HelperStatus = { status: 'stopped', restarts: 0 }
  private permissionsState: HelperPermissionState = { accessibility: 'unknown' }
  private intentionalStop = false
  private restartTimer: NodeJS.Timeout | undefined
  private updateTimer: NodeJS.Timeout | undefined
  private readyTimer: NodeJS.Timeout | undefined
  private disposed = false
  private resolvedExecutable = ''
  private macBuild: Promise<void> | undefined
  private macMonitorTimer: NodeJS.Timeout | undefined
  private macLaunchAt = 0

  constructor(options: HelperManagerOptions) {
    this.options = options
    mkdirSync(options.dataDir, { recursive: true })
    this.stateFile = join(options.dataDir, 'helper-state.json')
    this.configFile = join(options.dataDir, 'helper-config.json')
    this.commandFile = join(options.dataDir, 'command.json')
  }

  /** Native runtime this platform uses. */
  get kind(): HelperKind {
    return helperKindForPlatform()
  }

  /** Current status snapshot. */
  getStatus(): HelperStatus {
    return this.status
  }

  /** Last Accessibility permission reported by the helper (macOS only). */
  getPermissions(): HelperPermissionState {
    return { ...this.permissionsState }
  }

  /** Record the Accessibility permission from a helper status frame. */
  setAccessibility(granted: boolean): void {
    this.permissionsState = { accessibility: granted ? 'granted' : 'denied' }
  }

  /** Absolute path of the native helper entry point, kept for diagnostics. */
  get scriptPath(): string {
    return this.kind === 'swift' ? HELPER_MAC_APP : HELPER_WIN_SCRIPT
  }

  /** Whether the helper entry point ships with the package. */
  get scriptPresent(): boolean {
    if (this.kind === 'swift') return existsSync(HELPER_MAC_SOURCES)
    return existsSync(HELPER_WIN_SCRIPT)
  }

  /** Whether the macOS Swift sources ship with the package. */
  get sourcePresent(): boolean {
    return existsSync(HELPER_MAC_SOURCES)
  }

  /** Whether the compiled macOS app bundle exists right now. */
  get binaryPresent(): boolean {
    return existsSync(HELPER_MAC_APP)
  }

  /** Resolved (or best-known) helper executable path. */
  get executablePath(): string {
    if (this.resolvedExecutable !== '') return this.resolvedExecutable
    const configured = this.options.getSettings().advanced.helperPath.trim()
    if (configured !== '') return configured
    if (this.kind === 'powershell') return findPwshOnDisk('') ?? 'pwsh'
    if (this.kind === 'swift') return HELPER_MAC_APP
    return ''
  }

  /** Backward-compatible alias used by the Windows verification script. */
  get pwshPath(): string {
    return this.executablePath
  }

  /** Publish a status change to listeners. */
  private publish(patch: Partial<HelperStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.onStatusChange?.(this.status)
  }

  /** Resolve helper candidates in priority order. */
  async resolveCandidates(): Promise<string[]> {
    if (this.kind === 'none') return []
    const settings = this.options.getSettings()
    const configured = settings.advanced.helperPath.trim()
    if (this.kind === 'swift') {
      if (configured !== '') return [configured]
      return [HELPER_MAC_APP]
    }
    const candidates: string[] = []
    const push = (candidate: string): void => {
      const trimmed = candidate.trim()
      if (trimmed === '' || candidates.includes(trimmed) || isLegacyPowerShell(trimmed)) return
      candidates.push(trimmed)
    }
    const override = (this.options.helperPathOverride ?? '').trim()
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
  async resolveExecutable(): Promise<string | undefined> {
    return (await this.resolveCandidates())[0]
  }

  /** Backward-compatible alias for the Windows verification script. */
  async resolvePwshCandidates(): Promise<string[]> {
    return this.resolveCandidates()
  }

  /** Backward-compatible alias for the Windows verification script. */
  async resolvePwsh(): Promise<string | undefined> {
    return this.resolveExecutable()
  }

  /** Write the helper config file atomically. */
  private writeConfig(endpoint: HelperEndpoint, executable: string): HelperConfig {
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
    this.options.logger.info(
      `helper config written (${String(config.actions.length)} action(s), helper=${executable})`,
    )
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
  private attachChild(child: ChildProcess, executable: string): void {
    this.child = child
    this.resolvedExecutable = executable
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
    this.options.logger.info(`helper launched with ${executable} (pid=${String(child.pid ?? '')})`)
  }

  /** Spawn one executable and resolve once the OS reports success. */
  private spawnProcess(executable: string, args: string[]): Promise<ChildProcess> {
    return new Promise<ChildProcess>((resolveSpawn, rejectSpawn) => {
      let child: ChildProcess
      try {
        child = spawn(executable, args, {
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

  /** Spawn one PowerShell candidate; the config file is written first. */
  private spawnPowerShell(pwsh: string, endpoint: HelperEndpoint): Promise<ChildProcess> {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      HELPER_WIN_SCRIPT,
      '-ConfigPath',
      this.configFile,
    ]
    // Write the config before spawning: the helper reads it during startup.
    this.writeConfig(endpoint, pwsh)
    return this.spawnProcess(pwsh, args)
  }

  /**
   * Launch the macOS app bundle through LaunchServices. This is what makes the
   * bundle, instead of the DSH host, the TCC "responsible process" that owns the
   * Accessibility grant. stdin is not available on this path, so the helper
   * watches /v1/health and exits when the host disappears.
   */
  private async launchMacApp(appPath: string): Promise<void> {
    // macOS 27's `open` drops --args for this ad-hoc bundle, so the config path
    // travels through UserDefaults instead of argv.
    await this.writeMacPreference('HelperConfigPath', this.configFile)
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn('/usr/bin/open', ['-n', '-a', appPath], {
        cwd: this.options.dataDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', rejectLaunch)
      child.once('exit', code => {
        if (code === 0) resolveLaunch()
        else rejectLaunch(new Error(stderr.trim() !== '' ? stderr.trim() : `open 退出码 ${String(code ?? 'null')}`))
      })
    })
  }

  /** Write one launch preference the macOS app reads from UserDefaults. */
  private writeMacPreference(key: string, value: string): Promise<void> {
    return new Promise<void>((resolveWrite, rejectWrite) => {
      const child = spawn('/usr/bin/defaults', ['write', MAC_HELPER_BUNDLE_ID, key, '-string', value], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', rejectWrite)
      child.once('exit', code => {
        if (code === 0) resolveWrite()
        else rejectWrite(new Error(stderr.trim() !== '' ? stderr.trim() : `defaults 退出码 ${String(code ?? 'null')}`))
      })
    })
  }

  /** Read the pid the helper wrote into helper-state.json. */
  private readStatePid(): number | undefined {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const pid = (raw as { pid?: unknown }).pid
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  /** Whether a pid is alive; EPERM still means the process exists. */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as { code?: unknown }).code === 'EPERM'
    }
  }

  /** Terminate one helper pid gracefully, then forcefully after 2.5s. */
  private async terminatePid(pid: number): Promise<void> {
    if (!this.isPidAlive(pid)) return
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Could have exited between the check and the signal.
    }
    const started = Date.now()
    while (Date.now() - started < 2500) {
      await delay(100)
      if (!this.isPidAlive(pid)) return
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    await delay(100)
  }

  /** True when a helper process is alive for the current platform. */
  private isHelperAlive(): boolean {
    if (this.kind === 'swift') {
      const pid = this.status.pid ?? this.readStatePid()
      return pid !== undefined && this.isPidAlive(pid)
    }
    return this.child !== undefined
  }

  /** Stop a leftover macOS helper without publishing a final stopped state. */
  private async stopMacProcess(): Promise<void> {
    const pid = this.status.pid ?? this.readStatePid()
    if (pid !== undefined) await this.terminatePid(pid)
    this.publish({ pid: undefined })
  }

  /** Clear the macOS liveness monitor. */
  private clearMacMonitor(): void {
    if (this.macMonitorTimer !== undefined) {
      clearInterval(this.macMonitorTimer)
      this.macMonitorTimer = undefined
    }
  }

  /**
   * Watch the macOS helper pid after launch. The helper is a LaunchServices
   * child, so the host has no exit event; poll the pid that helper-state.json
   * reports and restart once when it disappears.
   */
  private startMacMonitor(): void {
    this.clearMacMonitor()
    this.macLaunchAt = Date.now()
    this.macMonitorTimer = setInterval(() => {
      if (this.disposed || this.intentionalStop) return
      if (Date.now() - this.macLaunchAt < 8000) return
      const pid = this.status.pid ?? this.readStatePid()
      if (pid !== undefined) {
        if (this.status.pid !== pid) this.publish({ pid })
        if (this.isPidAlive(pid)) return
      }
      if (this.status.status === 'stopped') return
      this.clearMacMonitor()
      this.options.logger.error('macOS helper process disappeared')
      if (this.status.status !== 'error') {
        this.publish({ status: 'error', pid: undefined, lastError: '助手进程已退出。' })
      }
      this.scheduleRestart()
    }, 5000)
    this.macMonitorTimer.unref?.()
  }

  /** Arm the watchdog that reports a helper which never announces readiness. */
  private armReadyTimer(): void {
    this.clearReadyTimer()
    this.readyTimer = setTimeout(() => {
      if (this.status.status === 'starting') {
        this.options.logger.warn('helper did not report ready within 15s')
        this.publish({ status: 'error', lastError: '助手进程启动后 15 秒内没有报告就绪，请查看日志。' })
      }
    }, READY_TIMEOUT_MS)
    this.readyTimer.unref?.()
  }

  /** Whether the Swift helper must be compiled (missing binary or newer sources). */
  private macHelperNeedsBuild(): boolean {
    try {
      if (!existsSync(HELPER_MAC_APP)) return true
      const binaryMtime = statSync(HELPER_MAC_BIN).mtimeMs
      const sourceMtime = Math.max(newestMtime(HELPER_MAC_SOURCES), statSync(MAC_BUILD_SCRIPT).mtimeMs)
      return sourceMtime > binaryMtime
    } catch {
      return true
    }
  }

  /** Compile the Swift helper once per plugin lifetime when needed. */
  private async ensureMacHelper(): Promise<void> {
    const configured = this.options.getSettings().advanced.helperPath.trim()
    if (configured !== '') {
      if (!existsSync(configured)) throw new Error(`设置的助手路径不存在：${configured}`)
      return
    }
    if (!this.macHelperNeedsBuild()) return
    if (this.macBuild !== undefined) return this.macBuild
    // A running instance keeps the old bundle image; stop it before replacing
    // files so the next LaunchServices launch picks up the new binary.
    await this.stopMacProcess()
    this.macBuild = this.buildMacHelper()
    try {
      await this.macBuild
    } finally {
      this.macBuild = undefined
    }
  }

  /** Run the swiftc build script; logs every line and fails with an actionable message. */
  private buildMacHelper(): Promise<void> {
    if (!existsSync(MAC_BUILD_SCRIPT)) {
      return Promise.reject(new Error(`找不到 macOS 构建脚本：${MAC_BUILD_SCRIPT}`))
    }
    this.options.logger.info('building macOS helper with swiftc')
    this.publish({ status: 'starting', lastError: '' })
    return new Promise<void>((resolveBuild, rejectBuild) => {
      const child = spawn('/bin/sh', [MAC_BUILD_SCRIPT], {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      const tail: string[] = []
      const collect = (stream: NodeJS.ReadableStream | null): void => {
        if (stream === null) return
        stream.setEncoding('utf8')
        let buffer = ''
        stream.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim() === '') continue
            tail.push(line)
            if (tail.length > 12) tail.shift()
            this.options.logger.info(`[helper:build] ${line}`)
          }
        })
      }
      collect(child.stdout)
      collect(child.stderr)
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        rejectBuild(new Error('编译超过 4 分钟，已终止。请检查 Xcode Command Line Tools。'))
      }, MAC_BUILD_TIMEOUT_MS)
      child.once('error', error => {
        clearTimeout(timer)
        rejectBuild(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        if (code === 0) {
          this.options.logger.info('macOS helper built')
          resolveBuild()
          return
        }
        const detail = tail.length > 0 ? tail.join(' / ') : '没有构建输出'
        rejectBuild(new Error(`swiftc 退出码 ${String(code ?? 'null')}：${detail}`))
      })
    })
  }

  /** Start the helper when the feature is enabled and the platform supports it. */
  async start(): Promise<void> {
    if (this.disposed) return
    const settings = this.options.getSettings()
    if (!settings.enabled) {
      this.publish({ status: 'stopped', lastError: '' })
      return
    }
    if (this.kind === 'none') {
      this.publish({ status: 'error', lastError: '划词助手支持 Windows 10/11 与 macOS 13.1 及以上。' })
      return
    }
    if (!this.scriptPresent) {
      const missing = this.kind === 'swift' ? HELPER_MAC_SOURCES : HELPER_WIN_SCRIPT
      this.publish({ status: 'error', lastError: `找不到助手文件：${missing}` })
      return
    }
    const endpoint = this.options.getEndpoint()
    if (endpoint === undefined) {
      this.publish({ status: 'error', lastError: '助手通信端口尚未就绪。' })
      return
    }
    this.intentionalStop = false
    this.publish({ status: 'starting', lastError: '' })
    if (this.kind === 'swift') {
      try {
        await this.ensureMacHelper()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.logger.error(`macOS helper build failed: ${message}`)
        this.publish({
          status: 'error',
          lastError: `无法构建 macOS 助手：${message}。请安装 Xcode Command Line Tools（xcode-select --install）后重启插件。`,
        })
        return
      }
      if (this.disposed || this.intentionalStop) return
      const configured = settings.advanced.helperPath.trim()
      const target = configured !== '' ? configured : HELPER_MAC_APP
      try {
        await this.stopMacProcess()
        this.writeConfig(endpoint, target)
        this.resolvedExecutable = target
        if (target.endsWith('.app')) {
          await this.launchMacApp(target)
          this.publish({ status: 'starting', pid: undefined, startedAt: Date.now(), lastError: '' })
          this.startMacMonitor()
          this.armReadyTimer()
        } else {
          const child = await this.spawnProcess(target, ['--config', this.configFile])
          this.attachChild(child, target)
        }
        this.options.logger.info(`macOS helper launched (${target})`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.logger.error(`macOS helper launch failed: ${message}`)
        this.publish({
          status: 'error',
          lastError: `无法启动助手进程（${target}）：${message}。请在设置 → 高级 → 助手路径里填写 SelectionAssistant.app 的完整路径。`,
        })
      }
      return
    }
    const candidates = await this.resolveCandidates()
    const failures: string[] = []
    for (const pwsh of candidates) {
      try {
        const child = await this.spawnPowerShell(pwsh, endpoint)
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
      lastError: `无法启动助手进程。已尝试：${failures.join('；')}。请在设置 → 高级 → 助手路径里填写 pwsh.exe 的完整路径。`,
    })
  }

  /** The helper announced readiness. */
  markReady(): void {
    this.clearReadyTimer()
    const pid = this.status.pid ?? this.readStatePid()
    this.publish({ status: 'running', lastError: '', pid, startedAt: this.status.startedAt ?? Date.now() })
    if (this.kind === 'swift') this.startMacMonitor()
    this.options.logger.info(`helper ready (pid=${String(pid ?? '')})`)
  }

  /** The helper reported a fatal error. */
  markError(message: string): void {
    this.clearReadyTimer()
    const pid = this.status.pid ?? this.readStatePid()
    this.publish({ status: 'error', lastError: message, pid })
    if (this.kind === 'swift') this.startMacMonitor()
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
    this.clearMacMonitor()
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    if (this.kind === 'swift') {
      let pid = this.status.pid ?? this.readStatePid()
      // The app writes helper-state.json shortly after LaunchServices starts it;
      // wait briefly so an immediate disable/restart does not orphan the process.
      for (let attempt = 0; pid === undefined && attempt < 10; attempt += 1) {
        await delay(100)
        pid = this.readStatePid()
      }
      if (pid !== undefined) await this.terminatePid(pid)
      this.child = undefined
      this.publish({ status: 'stopped', pid: undefined, lastError: '' })
      return
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
      if (this.isHelperAlive()) {
        void this.restart()
      } else {
        void this.start()
      }
    }, 350)
    this.updateTimer.unref?.()
  }

  /** Ask the helper to show a preview toolbar and result window. */
  preview(text: string): void {
    if (!this.isHelperAlive()) throw new Error('助手进程未在运行，请先启动。')
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
    this.clearMacMonitor()
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
