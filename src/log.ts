/**
 * File logger for the selection assistant plugin.
 *
 * The plugin writes one rolling log next to its settings (`plugin.log`), so a
 * failed helper launch or a rejected settings write is diagnosable without a
 * running settings page. The DSH host logger is mirrored when available.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Maximum size of one log file before it is rotated to `.1`. */
const MAX_BYTES = 1024 * 1024

/** Host logger surface this module uses (structural; no DSH import). */
export interface HostLoggerLike {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  debug: (message: string) => void
}

/** Levels ordered by verbosity. */
const LEVELS = ['error', 'warn', 'info', 'debug'] as const

/** One level of the plugin log. */
export type LogLevel = (typeof LEVELS)[number]

/** Minimal structured logger shared by the host modules. */
export class PluginLogger {
  private readonly file: string
  private level: LogLevel
  private readonly host: HostLoggerLike | undefined

  /**
   * @param dataDir - plugin data directory; created when missing.
   * @param level - minimum level to write.
   * @param host - optional DSH host logger to mirror into.
   */
  constructor(dataDir: string, level: LogLevel = 'info', host?: HostLoggerLike) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'plugin.log')
    this.level = level
    this.host = host
  }

  /** Change the minimum level at runtime (settings edits apply immediately). */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  /** Absolute path of the log file. */
  get path(): string {
    return this.file
  }

  /** Write one line. Never throws: logging failure must not break the feature. */
  log(level: LogLevel, message: string): void {
    if (LEVELS.indexOf(level) > LEVELS.indexOf(this.level)) return
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`)
      appendFileSync(this.file, line, 'utf8')
    } catch {
      // A read-only profile must not make the plugin fail.
    }
    try {
      const mirror = this.host
      if (mirror !== undefined) {
        if (level === 'error') mirror.error(message)
        else if (level === 'warn') mirror.warn(message)
        else if (level === 'debug') mirror.debug(message)
        else mirror.info(message)
      }
    } catch {
      // Host logger is best-effort as well.
    }
  }

  error(message: string): void {
    this.log('error', message)
  }

  warn(message: string): void {
    this.log('warn', message)
  }

  info(message: string): void {
    this.log('info', message)
  }

  debug(message: string): void {
    this.log('debug', message)
  }
}
