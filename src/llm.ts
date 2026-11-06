/**
 * Bridge from the selection assistant to the DSH `llm` service.
 *
 * The plugin never owns provider credentials or HTTP clients: it asks the host
 * for its configured default model (the desktop profile points that at DeepSeek)
 * and streams through `ctx.llm.prepareCall()/stream()`. A per-action model
 * override wins over the global selection, which wins over the host default.
 */
import type { ActionSettings, ModelOption, ProviderOption, Settings } from './contract.js'
import { SYSTEM_PROMPTS, SYSTEM_PROMPTS_EN, defaultPrompt } from './contract.js'
import { LanguageOverlapError, languageLabel, resolveTranslationTarget } from './lang.js'

/** One streamed chunk exposed to the SSE server. */
export type RunChunk =
  | { type: 'meta'; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; reason: 'stop' | 'max-tokens' | 'aborted' | 'tool-calls' }

/** Failure with a machine code and a user-facing Chinese message. */
export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/** Structural view of one provider model from the llm service. */
interface LlmModelInfoLike {
  id: string
  name?: string
}

/** Structural view of one provider from the llm service. */
interface LlmProviderInfoLike {
  id: string
  name?: string
}

/** Structural view of `ctx.llm` (the plugin imports no DSH package). */
export interface LlmServiceLike {
  listProviders(): LlmProviderInfoLike[]
  listModels(provider: string): Promise<LlmModelInfoLike[]>
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: Array<{ id: string; name?: string }>; defaultEffort?: string } }>
  prepareCall?(
    config: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<{
    config: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number; temperature?: number }
    stream(options: Record<string, unknown>): AsyncIterable<unknown>
  }>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/** Structural view of `ctx.agentDefaultModel`. */
export interface DefaultModelServiceLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** What the settings page needs to know about available routes. */
export interface LlmDefaults {
  provider: string
  model: string
  reasoningEffort: string
}

/** Default output cap for one assistant action; long selections still fit. */
const MAX_OUTPUT_TOKENS = 4096

/** Provider catalog cache lifetime. */
const PROVIDER_CACHE_MS = 60_000

/** Replace every occurrence of a placeholder. */
function replaceAll(haystack: string, needle: string, value: string): string {
  return haystack.split(needle).join(value)
}

/**
 * Instruction appended to the default translate prompt when the local detector
 * could not identify the source language and the configured target and fallback
 * are the same language. The model then reports a language overlap instead of
 * translating text that is already in the target language.
 */
function overlapHint(locale: 'zh' | 'en', targetLabel: string): string {
  if (locale === 'en') {
    return `If the text is already in ${targetLabel}, output only: 目标语言与源语言重叠`
  }
  return `如果原文已经是${targetLabel}，只输出：目标语言与源语言重叠`
}

/** Direct translation prompt used when the local detector resolved the target. */
function directTranslatePrompt(locale: 'zh' | 'en', targetLabel: string): string {
  if (locale === 'en') {
    return `Translate the following text into ${targetLabel}. Preserve paragraphs and list structure. Output only the translation.\n\n{{text}}`
  }
  return `把下面的文本翻译成${targetLabel}。保留段落与列表结构。只输出译文。\n\n{{text}}`
}

/**
 * Build the system and user messages for one action.
 * Translate actions first pick the target language from the selection so a
 * selection already written in the only configured target fails locally instead
 * of spending a model call.
 * @param action - configured action.
 * @param settings - current settings (language codes and UI locale).
 * @param text - the captured selection.
 * @returns Prompt pair ready for the llm service.
 */
export function buildActionPrompt(
  action: ActionSettings,
  settings: Settings,
  text: string,
): { system: string; user: string } {
  const locale = settings.language.ui
  const preset = action.preset
  const systemDefaults = locale === 'en' ? SYSTEM_PROMPTS_EN : SYSTEM_PROMPTS
  const system = action.systemPrompt.trim() !== '' ? action.systemPrompt : systemDefaults[preset]
  const configuredTarget = settings.language.target
  const fallbackLabel = languageLabel(settings.language.fallback, locale)
  let targetLabel = languageLabel(configuredTarget, locale)
  let needsOverlapHint = false
  let knownSource = false
  if (preset === 'translate') {
    const resolution = resolveTranslationTarget(text, configuredTarget, settings.language.fallback)
    if (resolution.overlap) throw new LanguageOverlapError('目标语言与源语言重叠')
    targetLabel = languageLabel(resolution.target, locale)
    knownSource = resolution.source.language !== 'unknown'
    needsOverlapHint = resolution.source.ambiguous && resolution.target === settings.language.fallback
  }
  const customPrompt = action.prompt.trim() !== ''
  let template = customPrompt
    ? action.prompt
    : knownSource
      ? directTranslatePrompt(locale, targetLabel)
      : defaultPrompt(preset, locale, targetLabel, fallbackLabel)
  if (!customPrompt && needsOverlapHint) template = `${template}\n\n${overlapHint(locale, targetLabel)}`
  let user = template
  user = replaceAll(user, '{{target}}', targetLabel)
  user = replaceAll(user, '{{fallback}}', fallbackLabel)
  user = replaceAll(user, '{{text}}', text)
  if (!template.includes('{{text}}')) user = `${template.trimEnd()}\n\n${text}`
  return { system, user }
}

/** Short user-facing label of one action in the configured UI language. */
export function actionLabel(action: ActionSettings, settings: Settings): string {
  return settings.language.ui === 'en' ? action.labelEn || action.labelZh : action.labelZh || action.labelEn
}

/**
 * Turn one llm service stream chunk into what the SSE layer needs.
 * Exported for the host verification script.
 */
export function interpretChunk(chunk: unknown): RunChunk | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const value = chunk as { type?: unknown; text?: unknown; reason?: { kind?: unknown } }
  if (value.type === 'text-delta' && typeof value.text === 'string') return { type: 'delta', text: value.text }
  if (value.type === 'finish') {
    const kind = value.reason?.kind
    if (kind === 'stop' || kind === 'max-tokens' || kind === 'aborted' || kind === 'tool-calls') {
      return { type: 'done', reason: kind }
    }
    if (kind === 'error') {
      const failure = (value.reason as { failure?: { code?: unknown; message?: unknown } }).failure
      throw new LlmError(
        typeof failure?.code === 'string' ? failure.code : 'llm-failed',
        typeof failure?.message === 'string' ? failure.message : '模型调用失败。',
      )
    }
    return { type: 'done', reason: 'stop' }
  }
  return undefined
}

/** Model bridge bound to one plugin context. */
export class LlmBridge {
  private providersCache: { at: number; value: ProviderOption[] } | undefined

  /**
   * @param getService - returns the live `ctx.llm` service or undefined.
   * @param getDefaultModel - returns the live `ctx.agentDefaultModel` service or undefined.
   */
  constructor(
    private readonly getService: () => LlmServiceLike | undefined,
    private readonly getDefaultModel: () => DefaultModelServiceLike | undefined,
  ) {}

  /** The host default route, or empty strings when no service reports one. */
  defaults(): LlmDefaults {
    try {
      const selection = this.getDefaultModel()?.currentSelection()
      if (selection !== undefined && selection.provider !== '') {
        return {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort ?? '',
        }
      }
    } catch {
      // A profile without a default model simply runs on explicit settings.
    }
    return { provider: '', model: '', reasoningEffort: '' }
  }

  /** Resolve the route for one action: action override, then global, then host default. */
  resolveRoute(action: ActionSettings, settings: Settings): { provider: string; model: string; reasoningEffort: string } {
    const defaults = this.defaults()
    const provider = action.model.provider || settings.model.provider || defaults.provider
    const model = action.model.model || settings.model.model || defaults.model
    const reasoningEffort = settings.model.reasoningEffort || (provider === defaults.provider && model === defaults.model ? defaults.reasoningEffort : '')
    if (provider === '' || model === '') {
      throw new LlmError('no-model', '没有可用的模型：请在设置里选择服务与模型，或先在 DSH 中配置默认模型。')
    }
    return { provider, model, reasoningEffort }
  }

  /**
   * Run one action and stream its chunks.
   * @param action - configured action.
   * @param text - captured selection.
   * @param settings - current settings.
   * @param signal - cancellation from the closed result window.
   */
  async *runAction(
    action: ActionSettings,
    text: string,
    settings: Settings,
    signal: AbortSignal,
  ): AsyncIterable<RunChunk> {
    const service = this.getService()
    if (service === undefined) {
      throw new LlmError('no-llm-service', '当前 profile 没有 LLM 服务，无法调用 DeepSeek。')
    }
    const route = this.resolveRoute(action, settings)
    const { system, user } = buildActionPrompt(action, settings, text)
    const request: { role: 'user'; content: Array<{ type: 'text'; text: string }> } = {
      role: 'user',
      content: [{ type: 'text', text: user }],
    }
    const callConfig: {
      provider: string
      model: string
      reasoningEffort?: string
      maxTokens: number
      temperature?: number
    } = {
      provider: route.provider,
      model: route.model,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(route.reasoningEffort !== '' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(settings.model.temperature === null ? {} : { temperature: settings.model.temperature }),
    }
    yield { type: 'meta', provider: route.provider, model: route.model }
    signal.throwIfAborted()
    let call: { config: typeof callConfig; stream(options: Record<string, unknown>): AsyncIterable<unknown> }
    try {
      call =
        service.prepareCall === undefined
          ? { config: callConfig, stream: options => service.stream(options) }
          : await service.prepareCall(callConfig, signal)
    } catch (error) {
      throw toLlmError(error)
    }
    const options: Record<string, unknown> = {
      ...call.config,
      messages: [request],
      signal,
      ...(system.trim() !== '' ? { system } : {}),
    }
    try {
      for await (const chunk of call.stream(options)) {
        const interpreted = interpretChunk(chunk)
        if (interpreted === undefined) continue
        yield interpreted
        if (interpreted.type === 'done') return
      }
    } catch (error) {
      if (signal.aborted) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
      throw toLlmError(error)
    }
    yield { type: 'done', reason: 'stop' }
  }

  /** Collect one non-streaming completion (settings page "测试" button). */
  async complete(text: string, settings: Settings, provider: string, model: string, signal: AbortSignal): Promise<string> {
    const action = settings.actions.find(entry => entry.id === 'translate') ?? settings.actions[0]
    if (action === undefined) throw new LlmError('no-action', '没有可用的动作。')
    const effective = sanitizeRouteOverride(settings, action, provider, model)
    let output = ''
    for await (const chunk of this.runAction(effective, text, settings, signal)) {
      if (chunk.type === 'delta') output += chunk.text
    }
    return output
  }

  /** List providers and models with reasoning metadata, cached briefly. */
  async providers(): Promise<ProviderOption[]> {
    const cached = this.providersCache
    if (cached !== undefined && Date.now() - cached.at < PROVIDER_CACHE_MS) return cached.value
    const service = this.getService()
    if (service === undefined) return []
    let providers: LlmProviderInfoLike[] = []
    try {
      providers = service.listProviders()
    } catch {
      return []
    }
    const result: ProviderOption[] = []
    for (const provider of providers) {
      const models: ModelOption[] = []
      try {
        const listed = await service.listModels(provider.id)
        for (const model of listed.slice(0, 60)) {
          let reasoningEfforts: Array<{ id: string; name: string }> = []
          let defaultReasoningEffort = ''
          if (service.resolveModelInfo !== undefined) {
            try {
              const resolved = await service.resolveModelInfo(provider.id, model.id, AbortSignal.timeout(4000))
              reasoningEfforts = (resolved.reasoning?.efforts ?? []).map(effort => ({
                id: effort.id,
                name: effort.name ?? effort.id,
              }))
              defaultReasoningEffort = resolved.reasoning?.defaultEffort ?? ''
            } catch {
              // Metadata is advisory; a model still lists without it.
            }
          }
          models.push({
            id: model.id,
            name: model.name ?? model.id,
            reasoningEfforts,
            defaultReasoningEffort,
          })
        }
      } catch {
        // A provider that cannot list models is still selectable by hand.
      }
      result.push({ provider: provider.id, name: provider.name ?? provider.id, models })
    }
    result.sort((left, right) => {
      const leftDeepSeek = left.provider.includes('deepseek') ? 0 : 1
      const rightDeepSeek = right.provider.includes('deepseek') ? 0 : 1
      return leftDeepSeek - rightDeepSeek || left.provider.localeCompare(right.provider)
    })
    this.providersCache = { at: Date.now(), value: result }
    return result
  }

  /** Drop the cached provider catalog (after settings that might change routes). */
  invalidate(): void {
    this.providersCache = undefined
  }
}

/** Copy one action with a route override for the test call. */
function sanitizeRouteOverride(settings: Settings, action: ActionSettings, provider: string, model: string): ActionSettings {
  if (provider === '' && model === '') return action
  return {
    ...action,
    model: {
      provider: provider !== '' ? provider : action.model.provider,
      model: model !== '' ? model : action.model.model,
    },
  }
}

/** Normalize an unknown thrown value into an LlmError with a Chinese message. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const value = error as { code?: unknown; message?: unknown; status?: unknown }
  const code = typeof value?.code === 'string' ? value.code : 'llm-failed'
  const message = typeof value?.message === 'string' && value.message !== '' ? value.message : '模型调用失败。'
  const friendly: Record<string, string> = {
    MODEL_UNSUPPORTED: '所选模型不受该服务支持，请重新选择模型。',
    MISSING_CREDENTIAL: 'DeepSeek 凭据缺失，请先在 DSH 中登录或配置 API Key。',
    INVALID_CREDENTIAL: 'DeepSeek 凭据无效，请重新登录或更新 API Key。',
    AUTH: '模型服务拒绝鉴权，请检查 DSH 的模型配置。',
    CLIENT_UPGRADE_REQUIRED: '当前客户端版本不支持所选模型，请升级 DSH。',
  }
  return new LlmError(code, friendly[code] ?? `模型调用失败：${message}`)
}
