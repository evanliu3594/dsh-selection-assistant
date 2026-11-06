/** Modal editor for one toolbar action (custom actions can also change type). */
import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ACTION_ICONS,
  SEARCH_ENGINES,
  type ActionSettings,
  type ProviderOption,
} from '../contract.ts'
import { ACTION_KINDS, isBuiltinAction } from './rules.ts'
import {
  BlockField,
  SelectField,
  iconLabel,
  iconShortLabel,
  type SelectOption,
  type Translate,
} from './ui.tsx'

/** Props the page hands one editor instance. */
export interface ActionEditorProps {
  t: Translate
  /** The action to edit; for a new custom action this is a blank draft. */
  action: ActionSettings
  isNew: boolean
  providers: ProviderOption[]
  onSave: (action: ActionSettings) => void
  onCancel: () => void
}

/**
 * Render the action editor dialog.
 * @param props - draft action, catalogue, and writers.
 * @returns the modal element.
 */
export function ActionEditor({ t, action, isNew, providers, onSave, onCancel }: ActionEditorProps) {
  const [draft, setDraft] = useState<ActionSettings>({
    ...action,
    model: { ...action.model },
  })
  const [error, setError] = useState('')

  const patch = (next: Partial<ActionSettings>): void => {
    setDraft(previous => ({ ...previous, ...next }))
  }

  const builtin = isBuiltinAction(draft.id)
  const selectedProvider = providers.find(entry => entry.provider === draft.model.provider)

  const engineId = draft.searchUrl.trim() === ''
    ? 'google'
    : SEARCH_ENGINES.find(engine => engine.url === draft.searchUrl)?.id ?? 'custom'
  const engineOptions: SelectOption[] = [
    ...SEARCH_ENGINES.map(engine => ({ value: engine.id, label: engine.label })),
    { value: 'custom', label: t('actions.editor.searchCustom') },
  ]

  const modelProviderOptions: SelectOption[] = [
    { value: '', label: t('actions.editor.modelFollow') },
    ...providers.map(entry => ({ value: entry.provider, label: entry.name !== '' ? entry.name : entry.provider })),
  ]
  const modelOptions: SelectOption[] = selectedProvider === undefined
    ? [{ value: '', label: t('actions.editor.modelFollow') }]
    : [
        { value: '', label: t('actions.editor.modelFollow') },
        ...selectedProvider.models.map(model => ({ value: model.id, label: model.name !== '' ? model.name : model.id })),
      ]

  const submit = (): void => {
    const labelZh = draft.labelZh.trim()
    const labelEn = draft.labelEn.trim()
    if (labelZh === '' && labelEn === '') {
      setError(t('actions.editor.errorName'))
      return
    }
    const searchUrl = draft.searchUrl.trim()
    if (draft.kind === 'search' && searchUrl !== '' && !searchUrl.includes('{{query}}')) {
      setError(t('actions.editor.errorSearchUrl'))
      return
    }
    const model = draft.model.provider === ''
      ? { provider: '', model: '' }
      : { provider: draft.model.provider, model: draft.model.model }
    onSave({ ...draft, labelZh, labelEn, searchUrl, model })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={isNew ? t('actions.editor.addTitle') : t('actions.editor.editTitle')}
      closeLabel={t('actions.editor.cancel')}
      footer={(
        <>
          <Button size="sm" variant="ghost" onClick={onCancel}>{t('actions.editor.cancel')}</Button>
          <Button size="sm" variant="primary" onClick={submit}>{t('actions.editor.save')}</Button>
        </>
      )}
    >
      <div className="sa-form">
        <div className="sa-form-row">
          <BlockField label={t('actions.editor.nameZh')}>
            <Input
              className="sa-input-full"
              value={draft.labelZh}
              aria-label={t('actions.editor.nameZh')}
              onChange={(event) => { patch({ labelZh: event.currentTarget.value }) }}
            />
          </BlockField>
          <BlockField label={t('actions.editor.nameEn')}>
            <Input
              className="sa-input-full"
              value={draft.labelEn}
              aria-label={t('actions.editor.nameEn')}
              onChange={(event) => { patch({ labelEn: event.currentTarget.value }) }}
            />
          </BlockField>
        </div>

        <BlockField label={t('actions.editor.icon')}>
          <div className="sa-icon-picker" role="group" aria-label={t('actions.editor.icon')}>
            {ACTION_ICONS.map(icon => (
              <button
                key={icon}
                type="button"
                className="sa-icon-option"
                aria-pressed={draft.icon === icon}
                title={iconLabel(icon, t)}
                onClick={() => { patch({ icon }) }}
              >
                <span className="sa-icon-option-glyph">{iconShortLabel(icon, t)}</span>
                <span>{iconLabel(icon, t)}</span>
              </button>
            ))}
          </div>
        </BlockField>

        <SelectField
          label={t('actions.editor.kind')}
          hint={builtin ? t('actions.editor.kindLocked') : undefined}
          value={draft.kind}
          disabled={builtin}
          options={ACTION_KINDS.map(kind => ({ value: kind, label: t(`actions.kind.${kind}`) }))}
          onChange={(next) => { patch({ kind: next as ActionSettings['kind'] }) }}
        />

        {draft.kind === 'llm' && (
          <>
            <BlockField label={t('actions.editor.prompt')} hint={t('actions.editor.promptHint')}>
              <textarea
                className="sa-textarea"
                value={draft.prompt}
                aria-label={t('actions.editor.prompt')}
                placeholder={t('actions.editor.promptPlaceholder')}
                onChange={(event) => { patch({ prompt: event.currentTarget.value }) }}
              />
            </BlockField>
            <BlockField label={t('actions.editor.systemPrompt')} hint={t('actions.editor.systemPromptHint')}>
              <textarea
                className="sa-textarea"
                value={draft.systemPrompt}
                aria-label={t('actions.editor.systemPrompt')}
                placeholder={t('actions.editor.systemPromptPlaceholder')}
                onChange={(event) => { patch({ systemPrompt: event.currentTarget.value }) }}
              />
            </BlockField>
            <div className="sa-form-row">
              <SelectField
                label={t('actions.editor.model')}
                hint={t('actions.editor.modelHint')}
                value={draft.model.provider}
                options={modelProviderOptions}
                onChange={(next) => { patch({ model: { provider: next, model: '' } }) }}
              />
              <SelectField
                label={t('model.model')}
                value={draft.model.model}
                options={modelOptions}
                disabled={draft.model.provider === ''}
                onChange={(next) => { patch({ model: { provider: draft.model.provider, model: next } }) }}
              />
            </div>
          </>
        )}

        {draft.kind === 'search' && (
          <>
            <SelectField
              label={t('actions.editor.searchEngine')}
              value={engineId}
              options={engineOptions}
              onChange={(next) => {
                const engine = SEARCH_ENGINES.find(entry => entry.id === next)
                if (engine !== undefined) patch({ searchUrl: engine.url })
              }}
            />
            <BlockField label={t('actions.editor.searchUrl')} hint={t('actions.editor.searchUrlHint')}>
              <Input
                className="sa-input-full"
                value={draft.searchUrl}
                aria-label={t('actions.editor.searchUrl')}
                onChange={(event) => { patch({ searchUrl: event.currentTarget.value }) }}
              />
            </BlockField>
          </>
        )}

        {error !== '' && <p className="sa-field-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
