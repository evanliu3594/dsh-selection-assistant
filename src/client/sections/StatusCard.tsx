/** Top card: the global enable switch and the helper process state. */
import { useState } from 'react'
import { Button, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Settings, StateDto } from '../../contract.ts'
import type { SettingsPatch } from '../../contract.ts'
import { describeError } from '../api.ts'
import { SectionCard, type Translate } from '../ui.tsx'

/** Helper status → state-dot semantic. */
const DOT = {
  running: 'done',
  starting: 'ongoing',
  stopped: 'idle',
  error: 'error',
} as const

/** Localized name of a helper status. */
function statusLabel(t: Translate, status: StateDto['helper']['status']): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'starting': return t('status.starting')
    case 'stopped': return t('status.stopped')
    default: return t('status.error')
  }
}

/** Props the page hands the status card. */
export interface StatusCardProps {
  t: Translate
  settings: Settings
  state: StateDto
  update: (patch: SettingsPatch) => void
  restart: () => Promise<void>
  /** Open the macOS Accessibility settings pane. */
  openPermissions: () => Promise<void>
}

/**
 * Render the status card.
 * @param props - settings, helper state, and writers.
 * @returns the card element.
 */
export function StatusCard({ t, settings, state, update, restart, openPermissions }: StatusCardProps) {
  const [busy, setBusy] = useState(false)
  const [restartError, setRestartError] = useState('')
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [permissionError, setPermissionError] = useState('')
  const helper = state.helper
  const helperStatus = helper.status
  const isMac = state.platform.os === 'darwin'
  // Tolerate a stale host half that predates the permissions field.
  const accessibility = state.platform.permissions?.accessibility ?? 'unknown'

  const runRestart = async (): Promise<void> => {
    setBusy(true)
    setRestartError('')
    try {
      await restart()
    } catch (error) {
      setRestartError(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const runOpenPermissions = async (): Promise<void> => {
    setPermissionBusy(true)
    setPermissionError('')
    try {
      await openPermissions()
    } catch (error) {
      setPermissionError(describeError(error))
    } finally {
      setPermissionBusy(false)
    }
  }

  return (
    <SectionCard
      title={t('status.title')}
      desc={t('status.desc')}
      extra={(
        <span className="sa-switch-label">
          <span>{t('status.enabled')}</span>
          <Switch
            checked={settings.enabled}
            label={t('status.enabled')}
            onChange={(next) => { update({ enabled: next }) }}
          />
        </span>
      )}
    >
      <div className="sa-status-line">
        <StateDot state={DOT[helperStatus]} />
        <span className="sa-status-text">{statusLabel(t, helperStatus)}</span>
        {helperStatus === 'running' && typeof helper.pid === 'number' && (
          <span className="sa-muted">{t('status.pid', { pid: helper.pid })}</span>
        )}
        {helperStatus === 'running' && typeof helper.runtime === 'string' && helper.runtime !== '' && (
          <span className="sa-muted">{t('status.runtime', { runtime: helper.runtime })}</span>
        )}
        {helper.restarts > 0 && (
          <span className="sa-muted">{t('status.restarts', { count: helper.restarts })}</span>
        )}
        <span className="sa-spacer" />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => { void runRestart() }}
        >
          {busy ? t('status.restarting') : t('status.restart')}
        </Button>
      </div>
      {helperStatus === 'error' && typeof helper.lastError === 'string' && helper.lastError !== '' && (
        <p className="sa-error-text">{t('status.errorDetail', { message: helper.lastError })}</p>
      )}
      {isMac && accessibility === 'granted' && (
        <p className="sa-muted">{t('status.accessibilityGranted')}</p>
      )}
      {isMac && accessibility === 'denied' && (
        <div className="sa-status-line">
          <span className="sa-warn-text">{t('status.accessibilityDenied')}</span>
          <span className="sa-spacer" />
          <Button
            size="sm"
            variant="outline"
            disabled={permissionBusy}
            onClick={() => { void runOpenPermissions() }}
          >
            {t('status.openPermissions')}
          </Button>
        </div>
      )}
      {isMac && accessibility === 'unknown' && (
        <p className="sa-muted">{t('status.accessibilityUnknown')}</p>
      )}
      {permissionError !== '' && (
        <p className="sa-error-text" role="alert">
          {t('status.openPermissionsFailed', { message: permissionError })}
        </p>
      )}
      {!state.platform.supported && (
        <p className="sa-warn-text">
          {t('status.unsupported', {
            reason: state.platform.reason !== '' ? state.platform.reason : state.platform.os,
          })}
        </p>
      )}
      {restartError !== '' && (
        <p className="sa-error-text" role="alert">{t('status.restartFailed', { message: restartError })}</p>
      )}
    </SectionCard>
  )
}
