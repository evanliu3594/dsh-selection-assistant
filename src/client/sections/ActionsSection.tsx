/** Action list card: ordering, enable switches, editor, and add/delete. */
import { useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActionSettings, ProviderOption, Settings, SettingsPatch } from '../../contract.ts'
import { ActionEditor } from '../ActionEditor.tsx'
import {
  createCustomAction,
  isBuiltinAction,
  moveAction,
  removeAction,
  setActionEnabled,
  sortActions,
  upsertAction,
} from '../rules.ts'
import { IconBadge, KindTag, SectionCard, type Translate } from '../ui.tsx'

/** One open editor session; `isNew` decides the dialog title. */
interface EditorSession {
  action: ActionSettings
  isNew: boolean
}

/** Props the page hands the action list card. */
export interface ActionsSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
  providers: ProviderOption[]
}

/**
 * Render the action list card.
 * @param props - settings, model catalogue, and the patch writer.
 * @returns the card element.
 */
export function ActionsSection({ t, settings, update, providers }: ActionsSectionProps) {
  const [session, setSession] = useState<EditorSession | null>(null)
  const sorted = sortActions(settings.actions)
  const enabled = sorted.filter(action => action.enabled).length

  const commit = (actions: ActionSettings[]): void => {
    update({ actions })
  }

  const openAdd = (): void => {
    const nextOrder = sorted.length === 0 ? 10 : ((sorted[sorted.length - 1] as ActionSettings).order + 10)
    setSession({ action: createCustomAction(nextOrder), isNew: true })
  }

  const openEdit = (action: ActionSettings): void => {
    setSession({ action: { ...action, model: { ...action.model } }, isNew: false })
  }

  const saveAction = (next: ActionSettings): void => {
    commit(upsertAction(settings.actions, next))
    setSession(null)
  }

  const renderName = (action: ActionSettings): { primary: string; secondary: string } => {
    const primary = action.labelZh !== '' ? action.labelZh : action.labelEn
    const secondary = action.labelZh !== '' && action.labelEn !== '' ? action.labelEn : ''
    return {
      primary: primary !== '' ? primary : t('common.none'),
      secondary,
    }
  }

  return (
    <SectionCard
      title={t('actions.title')}
      desc={t('actions.desc')}
      extra={<span className="sa-muted">{t('actions.count', { enabled, total: sorted.length })}</span>}
    >
      {sorted.length === 0 && <p className="sa-empty">{t('actions.empty')}</p>}
      {sorted.map((action, index) => {
        const name = renderName(action)
        const builtin = isBuiltinAction(action.id)
        const canDelete = !builtin && sorted.length > 1
        const deleteTitle = builtin
          ? t('actions.deleteBuiltin')
          : sorted.length <= 1 ? t('actions.deleteLast') : t('actions.delete')
        return (
          <div className="sa-action-row" key={action.id}>
            <IconBadge icon={action.icon} t={t} />
            <div className="sa-action-name-wrap">
              <span className="sa-action-name" title={name.primary}>{name.primary}</span>
              {name.secondary !== '' && <span className="sa-action-sub">{name.secondary}</span>}
            </div>
            <KindTag kind={action.kind} t={t} />
            <Switch
              checked={action.enabled}
              label={`${t('actions.enabled')}: ${name.primary}`}
              onChange={(next) => { commit(setActionEnabled(settings.actions, action.id, next)) }}
            />
            <button
              type="button"
              className="sa-icon-btn"
              title={t('actions.moveUp')}
              aria-label={t('actions.moveUp')}
              disabled={index === 0}
              onClick={() => { commit(moveAction(settings.actions, action.id, -1)) }}
            >↑</button>
            <button
              type="button"
              className="sa-icon-btn"
              title={t('actions.moveDown')}
              aria-label={t('actions.moveDown')}
              disabled={index === sorted.length - 1}
              onClick={() => { commit(moveAction(settings.actions, action.id, 1)) }}
            >↓</button>
            <button
              type="button"
              className="sa-icon-btn"
              title={t('actions.edit')}
              aria-label={t('actions.edit')}
              onClick={() => { openEdit(action) }}
            >✎</button>
            <button
              type="button"
              className="sa-icon-btn"
              title={deleteTitle}
              aria-label={t('actions.delete')}
              disabled={!canDelete}
              onClick={() => { commit(removeAction(settings.actions, action.id)) }}
            >✕</button>
          </div>
        )
      })}
      <div className="sa-actions-footer">
        <Button size="sm" variant="outline" onClick={openAdd}>+ {t('actions.add')}</Button>
      </div>
      {session !== null && (
        <ActionEditor
          key={`${session.isNew ? 'new' : 'edit'}-${session.action.id}`}
          t={t}
          action={session.action}
          isNew={session.isNew}
          providers={providers}
          onSave={saveAction}
          onCancel={() => { setSession(null) }}
        />
      )}
    </SectionCard>
  )
}
