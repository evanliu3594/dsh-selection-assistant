/**
 * The 划词助手 settings page: loads the host state, keeps the edited draft,
 * and saves changed fields on a 400 ms debounce.
 *
 * Save contract: only changed fields travel in the patch; `actions` is always
 * replaced as a whole. A failed save keeps the local draft and the pending
 * patch, so the next edit or the Retry action resubmits the same fields.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  PREVIEW_TEXT,
  type ProviderOption,
  type Settings,
  type SettingsPatch,
  type StateDto,
} from '../contract.ts'
import { describeError } from './api.ts'
import type { Api, LogsDto } from './api.ts'
import { isEmptyPatch, mergePatch, mergeSettings } from './rules.ts'
import { SaveStatus, type SavePhase, type Translate } from './ui.tsx'
import { ActionsSection } from './sections/ActionsSection.tsx'
import { AdvancedSection } from './sections/AdvancedSection.tsx'
import { AppFilterSection } from './sections/AppFilterSection.tsx'
import { ModelSection, type ModelsPhase } from './sections/ModelSection.tsx'
import { ResultSection } from './sections/ResultSection.tsx'
import { StatusCard } from './sections/StatusCard.tsx'
import { ToolbarSection } from './sections/ToolbarSection.tsx'
import { TriggerSection } from './sections/TriggerSection.tsx'

/** Debounce before a settings patch is written. */
const SAVE_DEBOUNCE_MS = 400

/** Lines requested by the log viewer. */
const LOG_LINES = 200

/** Props the registration inject face hands the page. */
export interface SettingsPageProps {
  t: Translate
  api: Api
}

/** Model catalogue as the page holds it. */
interface ModelCatalogue {
  phase: ModelsPhase
  providers: ProviderOption[]
  defaults: { provider: string; model: string; reasoningEffort: string }
}

/** Load lifecycle of the initial state request. */
type LoadPhase = 'loading' | 'ready' | 'error'

/**
 * Render the settings page.
 * @param props - translator and route client from the inject face.
 * @returns the page element tree.
 */
export function SettingsPage({ t, api }: SettingsPageProps) {
  const [loadPhase, setLoadPhase] = useState<LoadPhase>('loading')
  const [loadError, setLoadError] = useState('')
  const [state, setState] = useState<StateDto | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [savePhase, setSavePhase] = useState<SavePhase>('idle')
  const [saveError, setSaveError] = useState('')
  const [catalogue, setCatalogue] = useState<ModelCatalogue>({
    phase: 'loading',
    providers: [],
    defaults: { provider: '', model: '', reasoningEffort: '' },
  })

  const mountedRef = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const pendingRef = useRef<SettingsPatch>({})
  const timerRef = useRef<number | undefined>(undefined)
  const inflightRef = useRef(false)
  const editVersionRef = useRef(0)
  const retryRef = useRef(false)

  const scheduleFlush = (delay: number): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      void flush()
    }, delay)
  }

  /** Write the pending patch; concurrent calls are dropped and retried when the write settles. */
  const flush = async (): Promise<void> => {
    if (inflightRef.current) return
    const patch = pendingRef.current
    if (isEmptyPatch(patch)) {
      retryRef.current = false
      return
    }
    pendingRef.current = {}
    inflightRef.current = true
    const version = editVersionRef.current
    setSavePhase('saving')
    setSaveError('')
    let ok = false
    try {
      const next = await api.saveSettings(patch)
      ok = true
      if (mountedRef.current) {
        setState(next)
        if (isEmptyPatch(pendingRef.current)) setSavePhase('saved')
      }
    } catch (error) {
      pendingRef.current = mergePatch(patch, pendingRef.current)
      if (mountedRef.current) {
        setSavePhase('error')
        setSaveError(describeError(error))
      }
    } finally {
      inflightRef.current = false
      if (mountedRef.current) {
        const hasPending = !isEmptyPatch(pendingRef.current)
        const newerEdits = editVersionRef.current !== version
        if (hasPending && (retryRef.current || (ok && newerEdits))) {
          retryRef.current = false
          scheduleFlush(0)
        }
      }
    }
  }

  /** Merge a patch into the draft and schedule the debounced write. */
  const update = (patch: SettingsPatch): void => {
    setSettings(previous => (previous === null ? previous : mergeSettings(previous, patch)))
    pendingRef.current = mergePatch(pendingRef.current, patch)
    editVersionRef.current += 1
    setSavePhase('saving')
    setSaveError('')
    scheduleFlush(SAVE_DEBOUNCE_MS)
  }

  /** Resubmit the pending patch now (save-failure retry button). */
  const retrySave = (): void => {
    retryRef.current = true
    scheduleFlush(0)
  }

  const loadModels = async (signal: AbortSignal): Promise<void> => {
    setCatalogue(previous => ({ ...previous, phase: 'loading' }))
    try {
      const result = await api.getModels(signal)
      if (!mountedRef.current || signal.aborted) return
      setCatalogue({ phase: 'ready', providers: result.providers, defaults: result.defaults })
    } catch {
      if (!mountedRef.current || signal.aborted) return
      setCatalogue({ phase: 'error', providers: [], defaults: { provider: '', model: '', reasoningEffort: '' } })
    }
  }

  const load = async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoadPhase('loading')
    setLoadError('')
    try {
      const next = await api.getState(controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return
      setState(next)
      setSettings(next.settings)
      setLoadPhase('ready')
      void loadModels(controller.signal)
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return
      setLoadPhase('error')
      setLoadError(describeError(error))
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
      // A page closed inside the debounce window must not lose its last edit.
      const pending = pendingRef.current
      pendingRef.current = {}
      if (!isEmptyPatch(pending)) {
        void api.saveSettings(pending).catch(() => {})
      }
    }
    // The route client and translator are stable for the plugin's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const restart = async (): Promise<void> => {
    const next = await api.restartHelper()
    if (mountedRef.current) setState(next)
  }

  const preview = async (): Promise<void> => {
    await api.preview(PREVIEW_TEXT)
  }

  const getLogs = (): Promise<LogsDto> => api.getLogs(LOG_LINES)

  const isMac = state !== null && state.platform.os === 'darwin'
  const pageSubtitle = t(isMac ? 'page.subtitleMac' : 'page.subtitle')

  // macOS grants Accessibility outside the page. While the helper is in the
  // denied/error state, poll the host so the card turns green after the user
  // flips the switch in System Settings. Local settings drafts stay untouched.
  const needsStatusRefresh = state !== null
    && (state.helper.status === 'error' || state.platform.permissions.accessibility === 'denied')
  useEffect(() => {
    if (!needsStatusRefresh) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void api.getState().then((next) => {
        if (!cancelled && mountedRef.current) setState(next)
      }).catch(() => {})
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [needsStatusRefresh, api])

  if (loadPhase === 'error') {
    return (
      <div className="sa-root">
        <header className="sa-page-head">
          <div>
            <h2 className="sa-page-title">{t('page.title')}</h2>
            <p className="sa-page-sub">{pageSubtitle}</p>
          </div>
        </header>
        <div className="sa-error-banner" role="alert">
          <span>{t('page.loadFailed', { message: loadError })}</span>
          <Button size="sm" variant="outline" onClick={() => { void load() }}>{t('page.retry')}</Button>
        </div>
      </div>
    )
  }

  if (loadPhase === 'loading' || state === null || settings === null) {
    return (
      <div className="sa-root">
        <header className="sa-page-head">
          <div>
            <h2 className="sa-page-title">{t('page.title')}</h2>
            <p className="sa-page-sub">{pageSubtitle}</p>
          </div>
        </header>
        <p className="sa-loading">{t('page.loading')}</p>
      </div>
    )
  }

  const defaults = catalogue.defaults.provider !== '' || catalogue.defaults.model !== ''
    ? catalogue.defaults
    : state.defaults

  return (
    <div className="sa-root">
      <header className="sa-page-head">
        <div>
          <h2 className="sa-page-title">{t('page.title')}</h2>
          <p className="sa-page-sub">{pageSubtitle}</p>
        </div>
        <SaveStatus t={t} phase={savePhase} error={saveError} onRetry={retrySave} />
      </header>
      <StatusCard
        t={t}
        settings={settings}
        state={state}
        update={update}
        restart={restart}
        openPermissions={() => api.openPermissions()}
      />
      <TriggerSection t={t} settings={settings} update={update} os={state.platform.os} />
      <AppFilterSection t={t} settings={settings} update={update} os={state.platform.os} />
      <ToolbarSection t={t} settings={settings} update={update} />
      <ResultSection t={t} settings={settings} update={update} />
      <ActionsSection t={t} settings={settings} update={update} providers={catalogue.providers} />
      <ModelSection
        t={t}
        settings={settings}
        update={update}
        providers={catalogue.providers}
        defaults={defaults}
        modelsPhase={catalogue.phase}
      />
      <AdvancedSection
        t={t}
        settings={settings}
        state={state}
        update={update}
        restart={restart}
        preview={preview}
        getLogs={getLogs}
      />
    </div>
  )
}
