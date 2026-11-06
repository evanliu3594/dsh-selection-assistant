/** Advanced card: helper binary path, log level, process actions, and paths. */
import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Settings, SettingsPatch, StateDto } from '../../contract.ts'
import { describeError } from '../api.ts'
import type { LogsDto } from '../api.ts'
import { FieldRow, SectionCard, SelectField, type Translate } from '../ui.tsx'

/** Number of log lines the viewer asks the host for. */
const LOG_LINES = 200

/** Loaded log text plus its read status. */
interface LogState {
  status: 'loading' | 'ready' | 'error'
  text: string
  path: string
  error: string
}

/** Props the page hands the advanced card. */
export interface AdvancedSectionProps {
  t: Translate
  settings: Settings
  state: StateDto
  update: (patch: SettingsPatch) => void
  restart: () => Promise<void>
  preview: () => Promise<void>
  getLogs: () => Promise<LogsDto>
}

/**
 * Render the advanced card.
 * @param props - settings, host state, and the action callbacks.
 * @returns the card element.
 */
export function AdvancedSection({
  t, settings, state, update, restart, preview, getLogs,
}: AdvancedSectionProps) {
  const [helperPath, setHelperPath] = useState(settings.advanced.helperPath)
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartError, setRestartError] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewSent, setPreviewSent] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState<LogState>({ status: 'loading', text: '', path: '', error: '' })

  // Tolerate a stale host half while the plugin update is still hot-reloading.
  const legacyPwsh = (state.platform as { pwsh?: unknown }).pwsh
  const helperKind = state.platform.helperKind
    ?? (state.platform.os === 'win32' ? 'powershell' : state.platform.os === 'darwin' ? 'swift' : 'none')
  const detectedHelper = typeof state.platform.helper === 'string'
    ? state.platform.helper
    : typeof legacyPwsh === 'string' ? legacyPwsh : ''
  const isWindowsHelper = helperKind === 'powershell'
  const helperLabel = isWindowsHelper ? t('advanced.pwsh') : t('advanced.helperPath')
  const helperHint = detectedHelper !== ''
    ? t('advanced.pwshDetected', { path: detectedHelper })
    : isWindowsHelper ? t('advanced.pwshHint') : t('advanced.helperPathHint')
  const helperPlaceholder = isWindowsHelper
    ? t('advanced.pwshPlaceholder')
    : t('advanced.helperPathPlaceholder')

  const runRestart = async (): Promise<void> => {
    setRestartBusy(true)
    setRestartError('')
    try {
      await restart()
    } catch (error) {
      setRestartError(describeError(error))
    } finally {
      setRestartBusy(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    setPreviewBusy(true)
    setPreviewError('')
    setPreviewSent(false)
    try {
      await preview()
      setPreviewSent(true)
    } catch (error) {
      setPreviewError(describeError(error))
    } finally {
      setPreviewBusy(false)
    }
  }

  const openLogs = (): void => {
    setLogsOpen(true)
    setLogs({ status: 'loading', text: '', path: '', error: '' })
    void getLogs()
      .then((result) => {
        setLogs({ status: 'ready', text: result.text, path: result.path, error: '' })
      })
      .catch((error: unknown) => {
        setLogs({ status: 'error', text: '', path: '', error: describeError(error) })
      })
  }

  return (
    <SectionCard title={t('advanced.title')} desc={t('advanced.desc')}>
      <FieldRow label={helperLabel} hint={helperHint}>
        <Input
          className="sa-input-wide"
          value={helperPath}
          aria-label={helperLabel}
          placeholder={helperPlaceholder}
          onChange={(event) => {
            const next = event.currentTarget.value
            setHelperPath(next)
            update({ advanced: { helperPath: next } })
          }}
        />
      </FieldRow>
      <SelectField
        label={t('advanced.logLevel')}
        hint={t('advanced.logLevelHint')}
        value={settings.advanced.logLevel}
        options={[
          { value: 'error', label: t('advanced.log.error') },
          { value: 'warn', label: t('advanced.log.warn') },
          { value: 'info', label: t('advanced.log.info') },
          { value: 'debug', label: t('advanced.log.debug') },
        ]}
        onChange={(next) => {
          update({ advanced: { logLevel: next as Settings['advanced']['logLevel'] } })
        }}
      />
      <div className="sa-actions-row">
        <Button size="sm" variant="outline" disabled={restartBusy} onClick={() => { void runRestart() }}>
          {restartBusy ? t('advanced.restarting') : t('advanced.restart')}
        </Button>
        <Button size="sm" variant="outline" disabled={previewBusy} onClick={() => { void runPreview() }}>
          {t('advanced.preview')}
        </Button>
        <Button size="sm" variant="outline" onClick={openLogs}>{t('advanced.logs')}</Button>
      </div>
      {restartError !== '' && (
        <p className="sa-error-text" role="alert">{t('advanced.restartFailed', { message: restartError })}</p>
      )}
      {previewError !== '' && (
        <p className="sa-error-text" role="alert">{t('advanced.previewFailed', { message: previewError })}</p>
      )}
      {previewSent && (
        <p className="sa-muted">
          {t('advanced.previewSent')}
          {state.helper.status !== 'running' ? ` ${t('advanced.previewNoHelper')}` : ''}
        </p>
      )}
      <div className="sa-paths">
        <span className="sa-path-line">
          {t('advanced.dataDir', { path: state.paths.dataDir !== '' ? state.paths.dataDir : t('common.none') })}
        </span>
        <span className="sa-path-line">
          {t('advanced.logPath', { path: state.paths.log !== '' ? state.paths.log : t('common.none') })}
        </span>
      </div>
      <Modal
        open={logsOpen}
        onClose={() => { setLogsOpen(false) }}
        title={t('advanced.logsTitle', { lines: LOG_LINES })}
        closeLabel={t('advanced.close')}
        footer={<Button size="sm" variant="ghost" onClick={() => { setLogsOpen(false) }}>{t('advanced.close')}</Button>}
      >
        {logs.status === 'loading' && <p className="sa-empty">{t('advanced.logsLoading')}</p>}
        {logs.status === 'error' && (
          <p className="sa-field-error" role="alert">{t('advanced.logsFailed', { message: logs.error })}</p>
        )}
        {logs.status === 'ready' && (
          <>
            {logs.path !== '' && <p className="sa-log-meta">{logs.path}</p>}
            {logs.text === ''
              ? <p className="sa-empty">{t('advanced.logsEmpty')}</p>
              : <pre className="sa-log">{logs.text}</pre>}
          </>
        )}
      </Modal>
    </SectionCard>
  )
}
