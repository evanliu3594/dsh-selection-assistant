/**
 * dsh-selection-assistant — browser half: the 划词助手 settings page.
 *
 * Registers one `settings.section` entry (id `selection-assistant`, order 30)
 * and injects the page stylesheet. Components never touch `ctx`: the page and
 * its sections receive `{ t, api }` through the registration's inject face,
 * exactly like the rest of the settings shell.
 *
 * Exports are named-only on purpose: a default export here would make the
 * loader discard this namespace, `inject` included.
 */
import type { Context } from '@deepseek-ai/cordis'
import { api } from './api.ts'
import { en, zh } from './locales.ts'
import { SettingsPage } from './SettingsPage.tsx'
import { STYLES } from './styles.ts'

/** Services required before this half can register anything. */
export const inject = ['slots', 'locale']

/** Namespace of the browser-side dictionary. */
const NS = 'selection-assistant'

/** The shape of the client services this half uses, declared structurally. */
interface ClientContextLike {
  effect: (callback: () => (() => void) | void, label?: string) => () => void
  locale: {
    register: (ns: string, dictionaries: Record<string, Record<string, string>>) => () => void
    bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
  }
  slots: {
    inject: (name: string, callback: () => () => void) => () => void
    register: (spec: Record<string, unknown>, component: unknown) => () => void
  }
}

/**
 * Attach the page stylesheet.
 * @returns the disposer removing the style element on unload.
 */
function attachStyles(): () => void {
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => style.remove()
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const client = ctx as unknown as ClientContextLike

  client.effect(() => client.locale.register(NS, { zh, en }), 'selection-assistant: dictionaries')
  client.effect(attachStyles, 'selection-assistant: styles')

  const t = client.locale.bind(NS)

  client.slots.inject('settings.section', () => client.slots.register(
    {
      name: 'settings.section',
      id: 'selection-assistant',
      order: 30,
      label: () => t('section'),
      // Declaring the namespace gives every entry the framework's locale seat, so
      // a language switch re-renders this page with fresh copy.
      locale: NS,
      inject: () => ({ t, api }),
    },
    SettingsPage,
  ))
}
