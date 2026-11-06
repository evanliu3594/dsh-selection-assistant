/**
 * Two HTTP surfaces owned by the plugin:
 *
 * 1. Settings routes on the DSH web server (`/selection-assistant/*`), called by
 *    the browser settings page over same-origin fetch.
 * 2. A loopback action server (`127.0.0.1:<random port>`) called by the helper
 *    process with a per-launch bearer token; it streams model output as SSE.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { once } from 'node:events'
import type { ProviderOption, RouteError, Settings, StateDto } from './contract.js'
import { PREVIEW_TEXT, ROUTE_PREFIX } from './contract.js'
import type { HelperManager } from './helper.js'
import type { LlmBridge } from './llm.js'
import type { PluginLogger } from './log.js'
import type { SettingsStore } from './settings.js'

/** Largest JSON body accepted on either surface. */
const MAX_BODY_BYTES = 1024 * 1024

/** Largest selection text forwarded to the model. */
const MAX_SELECTION_CHARS = 20_000

/** Structural web-server registration used by the settings surface. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Everything the HTTP surfaces read from the plugin instance. */
export interface ServerDeps {
  dataDir: string
  logPath: string
  pluginLogPath: string
  version: string
  settings: SettingsStore
  llm: LlmBridge
  helper: HelperManager
  logger: PluginLogger
  pwshPath: () => string
  platformSupported: () => boolean
  platformReason: () => string
  onSettingsSaved: (next: Settings) => void
}

/** One helper-reported status frame. */
interface StatusFrame {
  state?: unknown
  message?: unknown
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Write one structured failure. */
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  const body: { ok: false; error: RouteError } = { ok: false, error: { code, message } }
  sendJson(res, status, body)
}

/** Read a JSON request body with a byte cap. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体超过 1 MB 上限。')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/** Compare the bearer token without leaking length or content through timing. */
function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** Write one SSE frame and respect backpressure. */
async function writeEvent(res: ServerResponse, event: string, data: unknown): Promise<void> {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  if (!res.write(frame)) await once(res, 'drain')
}

/** Current plugin state for the settings page. */
export function buildState(deps: ServerDeps): StateDto {
  const settings = deps.settings.get()
  const helper = deps.helper.getStatus()
  const defaults = deps.llm.defaults()
  return {
    settings,
    helper,
    platform: {
      os: process.platform,
      arch: process.arch,
      pwsh: deps.pwshPath(),
      supported: deps.platformSupported(),
      reason: deps.platformReason(),
    },
    defaults,
    paths: { dataDir: deps.dataDir, log: deps.logPath },
    version: deps.version,
  }
}

/** Tail of a text file, or an empty string when unreadable. */
function tailFile(path: string, maxLines: number): string {
  try {
    if (!existsSync(path)) return ''
    const text = readFileSync(path, 'utf8')
    const lines = text.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
  } catch {
    return ''
  }
}

/**
 * Build the `/selection-assistant` prefix handler used by the settings page.
 * @param deps - plugin instance state.
 * @returns A web-server compatible handler.
 */
export function createSettingsHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    try {
      if (path === `${ROUTE_PREFIX}/state`) {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '该路由只支持 GET。')
        return sendJson(res, 200, { ok: true, state: buildState(deps) })
      }
      if (path === `${ROUTE_PREFIX}/models`) {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '该路由只支持 GET。')
        const providers: ProviderOption[] = await deps.llm.providers()
        return sendJson(res, 200, { ok: true, providers, defaults: deps.llm.defaults() })
      }
      if (path === `${ROUTE_PREFIX}/settings`) {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '该路由只支持 POST。')
        const body = await readJsonBody(req)
        const patch = (body as { patch?: unknown } | undefined)?.patch
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          return fail(res, 400, 'bad-request', '请求体必须是 { "patch": { ... } }。')
        }
        const next = deps.settings.patch(patch as Parameters<SettingsStore['patch']>[0])
        deps.onSettingsSaved(next)
        deps.logger.info('settings saved from the settings page')
        return sendJson(res, 200, { ok: true, state: buildState(deps) })
      }
      if (path === `${ROUTE_PREFIX}/test`) {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '该路由只支持 POST。')
        const body = (await readJsonBody(req)) as { provider?: unknown; model?: unknown; text?: unknown } | undefined
        const provider = typeof body?.provider === 'string' ? body.provider : ''
        const model = typeof body?.model === 'string' ? body.model : ''
        const sample = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text : PREVIEW_TEXT
        const settings = deps.settings.get()
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        const timeout = setTimeout(() => controller.abort(), 90_000)
        timeout.unref?.()
        try {
          const text = await deps.llm.complete(sample, settings, provider, model, controller.signal)
          return sendJson(res, 200, { ok: true, text, provider: provider || settings.model.provider, model: model || settings.model.model })
        } finally {
          clearTimeout(timeout)
        }
      }
      if (path === `${ROUTE_PREFIX}/helper/restart`) {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '该路由只支持 POST。')
        await deps.helper.restart()
        return sendJson(res, 200, { ok: true, state: buildState(deps) })
      }
      if (path === `${ROUTE_PREFIX}/helper/preview`) {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', '该路由只支持 POST。')
        const body = (await readJsonBody(req)) as { text?: unknown } | undefined
        const sample = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text : PREVIEW_TEXT
        try {
          deps.helper.preview(sample)
        } catch (error) {
          return fail(res, 409, 'helper-not-running', error instanceof Error ? error.message : '助手进程未在运行。')
        }
        return sendJson(res, 200, { ok: true })
      }
      if (path === `${ROUTE_PREFIX}/logs`) {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', '该路由只支持 GET。')
        const requested = Number(url.searchParams.get('lines') ?? '200')
        const lines = Number.isFinite(requested) ? Math.min(1000, Math.max(20, Math.trunc(requested))) : 200
        const helperText = tailFile(deps.logPath, lines)
        const pluginText = tailFile(deps.pluginLogPath, Math.max(20, Math.trunc(lines / 2)))
        const text = `===== plugin.log =====\n${pluginText}\n\n===== helper.log =====\n${helperText}`
        return sendJson(res, 200, { ok: true, path: deps.logPath, text })
      }
      return fail(res, 404, 'unknown-route', `未知路由 ${path}`)
    } catch (error) {
      deps.logger.error(`settings route failed: ${path}: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) return fail(res, 500, 'internal', error instanceof Error ? error.message : '内部错误。')
    }
  }
}

/** Loopback HTTP server the helper calls. */
export class ActionServer {
  /** Random bearer token regenerated on every plugin start. */
  readonly token = randomBytes(32).toString('hex')

  private server: Server | undefined
  private port = 0
  private closed = false

  /**
   * @param deps - plugin instance state.
   */
  constructor(private readonly deps: ServerDeps) {}

  /** Endpoint descriptor for the helper config, once listening. */
  get endpoint(): { url: string; token: string } | undefined {
    if (this.server === undefined || this.port === 0) return undefined
    return { url: `http://127.0.0.1:${String(this.port)}`, token: this.token }
  }

  /** Bind an ephemeral loopback port. */
  async start(): Promise<void> {
    if (this.server !== undefined || this.closed) return
    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    server.on('error', error => {
      this.deps.logger.error(`action server error: ${error.message}`)
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    this.port = typeof address === 'object' && address !== null ? address.port : 0
    this.server = server
    this.deps.logger.info(`action server listening on 127.0.0.1:${String(this.port)}`)
    // Disposal may have raced the asynchronous listen; never leave a listener behind.
    if (this.closed) await this.close()
  }

  /** Close the server and drop every in-flight request. */
  async close(): Promise<void> {
    this.closed = true
    const server = this.server
    this.server = undefined
    this.port = 0
    if (server === undefined) return
    await new Promise<void>(resolveClose => {
      server.close(() => {
        resolveClose()
      })
      server.closeAllConnections()
    })
  }

  /** Route one helper request. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true })
      }
      if (!tokenMatches(req.headers.authorization, this.token)) {
        return fail(res, 401, 'unauthorized', '助手 token 无效。')
      }
      if (url.pathname === '/v1/status' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as StatusFrame | undefined
        if (body?.state === 'ready') this.deps.helper.markReady()
        else if (body?.state === 'error') this.deps.helper.markError(typeof body.message === 'string' ? body.message : '助手报告错误。')
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/v1/log' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { level?: unknown; message?: unknown } | undefined
        const level = body?.level === 'error' || body?.level === 'warn' || body?.level === 'debug' ? body.level : 'info'
        this.deps.logger.log(level, `[helper] ${typeof body?.message === 'string' ? body.message : ''}`)
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/v1/action' && req.method === 'POST') {
        return await this.streamAction(req, res)
      }
      return fail(res, 404, 'unknown-route', `未知路由 ${url.pathname}`)
    } catch (error) {
      this.deps.logger.error(`action server request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) fail(res, 500, 'internal', error instanceof Error ? error.message : '内部错误。')
      else res.end()
    }
  }

  /** Stream one action's model output as server-sent events. */
  private async streamAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as
      | { actionId?: unknown; text?: unknown; requestId?: unknown }
      | undefined
    const actionId = typeof body?.actionId === 'string' ? body.actionId : ''
    const text = typeof body?.text === 'string' ? body.text : ''
    if (actionId === '' || text.trim() === '') {
      return fail(res, 400, 'bad-request', '缺少 actionId 或 text。')
    }
    if (text.length > MAX_SELECTION_CHARS) {
      return fail(res, 413, 'too-long', `选中文本超过 ${String(MAX_SELECTION_CHARS)} 字上限。`)
    }
    const settings = this.deps.settings.get()
    const action = settings.actions.find(entry => entry.id === actionId)
    if (action === undefined) {
      return fail(res, 404, 'unknown-action', `动作 ${actionId} 不存在。`)
    }
    if (action.kind !== 'llm') {
      return fail(res, 400, 'local-action', `动作 ${actionId} 在助手端本地执行，不需要模型。`)
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    res.on('close', abort)
    req.on('close', abort)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.flushHeaders?.()
    try {
      const label = settings.language.ui === 'en' ? action.labelEn || action.labelZh : action.labelZh || action.labelEn
      await writeEvent(res, 'meta', {
        provider: '',
        model: '',
        label,
        requestId: typeof body?.requestId === 'string' ? body.requestId : '',
      })
      let provider = ''
      let model = ''
      for await (const chunk of this.deps.llm.runAction(action, text, settings, controller.signal)) {
        if (controller.signal.aborted) break
        if (chunk.type === 'meta') {
          provider = chunk.provider
          model = chunk.model
          await writeEvent(res, 'meta', { provider, model, label })
          continue
        }
        if (chunk.type === 'delta') {
          await writeEvent(res, 'delta', { text: chunk.text })
          continue
        }
        await writeEvent(res, 'done', { reason: chunk.reason })
        res.end()
        return
      }
      if (!res.writableEnded) {
        await writeEvent(res, 'done', { reason: 'aborted' })
        res.end()
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const message = error instanceof Error ? error.message : '模型调用失败。'
      this.deps.logger.error(`action ${actionId} failed: ${message}`)
      if (!res.writableEnded) {
        try {
          await writeEvent(res, 'error', { code: typeof code === 'string' ? code : 'llm-failed', message })
        } catch {
          // Client already went away.
        }
        res.end()
      }
    }
  }
}

/** Read one route path from the plugin settings surface for diagnostics. */
export function settingsRoutePaths(): string[] {
  return [
    `${ROUTE_PREFIX}/state`,
    `${ROUTE_PREFIX}/settings`,
    `${ROUTE_PREFIX}/models`,
    `${ROUTE_PREFIX}/test`,
    `${ROUTE_PREFIX}/helper/restart`,
    `${ROUTE_PREFIX}/helper/preview`,
    `${ROUTE_PREFIX}/logs`,
  ]
}
