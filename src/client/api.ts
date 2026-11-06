/**
 * HTTP client for the Host routes under `/selection-assistant`.
 *
 * One failure shape for every call: {@link ApiFailure} carries the host's
 * `{ code, message }` when the response has one, and a Chinese message when the
 * request never reached the host. Callers only ever show `error.message`.
 */
import {
  ROUTE_PREFIX,
  type ProviderOption,
  type SettingsPatch,
  type StateDto,
} from '../contract.ts'

/** Error payload every route returns on failure. */
export interface RouteError {
  code: string
  message: string
}

/** A failed route call, already normalized to the host's error shape. */
export class ApiFailure extends Error {
  /** Host error code, or `network-failed` / `http-<status>` locally. */
  readonly code: string
  /** HTTP status when a response arrived; `0` for transport failures. */
  readonly status: number

  /**
   * @param code - host error code or a local transport code.
   * @param message - user-facing Chinese message.
   * @param status - HTTP status, or 0 when no response arrived.
   */
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
    this.status = status
  }
}

/** Model catalogue returned by `GET /models`. */
export interface ModelsDto {
  providers: ProviderOption[]
  defaults: { provider: string; model: string; reasoningEffort: string }
}

/** Body returned by `GET /logs`. */
export interface LogsDto {
  path: string
  text: string
}

/** Message shown for any Chinese-facing failure message. */
function describeError(error: unknown): string {
  if (error instanceof ApiFailure) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Structural check for a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Parse a response body, tolerating hosts that answer with HTML or nothing. */
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** One route call: fetch, decode JSON, and normalize every failure. */
async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  let response: Response
  try {
    response = await fetch(`${ROUTE_PREFIX}${path}`, {
      method: init.method ?? 'GET',
      headers: body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
      signal: init.signal,
      cache: 'no-store',
    })
  } catch (error) {
    if (init.signal?.aborted === true) throw error
    throw new ApiFailure('network-failed', '无法连接宿主，请确认 DSH 正在运行。')
  }
  const payload = await readBody(response)
  const record = isRecord(payload) ? payload : {}
  if (response.ok && record.ok !== false) return payload as T
  const error = isRecord(record.error) ? record.error : {}
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : `http-${response.status}`
  const message = typeof error.message === 'string' && error.message !== ''
    ? error.message
    : `宿主路由返回 HTTP ${response.status}`
  throw new ApiFailure(code, message, response.status)
}

/** Read a state envelope (`{ ok: true, state }`) and return its state. */
async function stateOf(request: Promise<{ state: StateDto }>): Promise<StateDto> {
  const payload = await request
  return payload.state
}

/** Every route the settings page uses. */
export const api = {
  /**
   * Read the current settings + helper state.
   * @param signal - cancels the request when the page unmounts.
   * @returns the full state document.
   */
  getState: (signal?: AbortSignal): Promise<StateDto> =>
    stateOf(call<{ ok: true; state: StateDto }>('/state', { signal })),

  /**
   * Deep-merge a settings patch; `actions` replaces the whole array.
   * @param patch - changed fields only.
   * @returns the updated full state.
   */
  saveSettings: (patch: SettingsPatch): Promise<StateDto> =>
    stateOf(call<{ ok: true; state: StateDto }>('/settings', { method: 'POST', body: { patch } })),

  /**
   * Read the model catalogue advertised by the host.
   * @param signal - cancels the request when the page unmounts.
   * @returns provider options plus the DSH defaults.
   */
  async getModels(signal?: AbortSignal): Promise<ModelsDto> {
    const payload = await call<{
      ok: true
      providers?: unknown
      defaults?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    }>('/models', { signal })
    const providers = Array.isArray(payload.providers) ? payload.providers as ProviderOption[] : []
    const defaults = payload.defaults ?? {}
    return {
      providers,
      defaults: {
        provider: typeof defaults.provider === 'string' ? defaults.provider : '',
        model: typeof defaults.model === 'string' ? defaults.model : '',
        reasoningEffort: typeof defaults.reasoningEffort === 'string' ? defaults.reasoningEffort : '',
      },
    }
  },

  /** Restart the helper process and return the refreshed state. */
  restartHelper: (): Promise<StateDto> =>
    stateOf(call<{ ok: true; state: StateDto }>('/helper/restart', { method: 'POST', body: {} })),

  /**
   * Open the macOS Accessibility settings pane.
   * @returns nothing; a failure rejects with the host's {@link ApiFailure}.
   */
  async openPermissions(): Promise<void> {
    await call<{ ok: true }>('/helper/open-permissions', { method: 'POST', body: {} })
  },

  /**
   * Ask the helper to show the toolbar and result window with sample text.
   * @param text - sample text the result window renders.
   */
  async preview(text: string): Promise<void> {
    await call<{ ok: true }>('/helper/preview', { method: 'POST', body: { text } })
  },

  /**
   * Read the tail of the helper log.
   * @param lines - how many trailing lines to request.
   * @returns the log file path and its text.
   */
  async getLogs(lines = 200): Promise<LogsDto> {
    const payload = await call<{ ok: true; path?: unknown; text?: unknown }>(
      `/logs?lines=${encodeURIComponent(String(lines))}`,
    )
    return {
      path: typeof payload.path === 'string' ? payload.path : '',
      text: typeof payload.text === 'string' ? payload.text : '',
    }
  },
}

/** The route surface the page receives through its registration inject face. */
export type Api = typeof api

export { describeError }
