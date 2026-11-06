/**
 * Stylesheet for the 划词助手 settings page.
 *
 * Injected as a `<style>` element from the plugin body; the module loader owns
 * the element and removes it when the plugin unloads. Every color is a DSH
 * `--dsw-alias-*` token, so light and dark follow the app theme. Class names are
 * prefixed `sa-` to stay clear of the shell's own CSS.
 */

export const STYLES = `
.sa-root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;padding-bottom:24px;color:var(--dsw-alias-label-primary)}

/* page header */
.sa-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.sa-page-title{margin:0;font-size:16px;line-height:22px;font-weight:600}
.sa-page-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sa-spacer{flex:1}

/* cards */
.sa-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px}
.sa-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}
.sa-card-title{margin:0;font-size:14px;line-height:20px;font-weight:600}
.sa-card-desc{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sa-card-extra{display:flex;align-items:center;gap:8px;flex:none}

/* field rows */
.sa-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 0;min-height:28px}
.sa-row-text{flex:1 1 auto;min-width:0}
.sa-row-label{font-size:13px;line-height:18px}
.sa-row-hint{margin-top:1px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;word-break:break-word}
.sa-row-control{display:flex;align-items:center;gap:8px;flex:none}
.sa-block{display:flex;flex-direction:column;gap:6px;padding:8px 0}
.sa-block-control{display:flex;flex-direction:column;gap:6px}
.sa-switch-label{display:inline-flex;align-items:center;gap:8px;font-size:13px}

/* controls */
.sa-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
.sa-slider{width:180px;height:20px;accent-color:var(--dsw-alias-brand-primary);background:transparent;cursor:pointer}
.sa-select{font-size:12px;height:32px;max-width:280px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sa-select:disabled{opacity:.5;cursor:default}
.sa-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-input{width:220px}
.sa-input-full{box-sizing:border-box;width:100%}
.sa-input-wide{width:300px}
.sa-input-narrow{width:160px}
.sa-textarea{box-sizing:border-box;width:100%;min-height:84px;padding:8px;font-family:inherit;font-size:12px;line-height:18px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);resize:vertical}
.sa-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* status */
.sa-status-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}
.sa-status-text{font-size:13px;line-height:18px;font-weight:500}
.sa-muted{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sa-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sa-error-text{margin:4px 0 0;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.sa-warn-text{margin:4px 0 0;font-size:12px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.sa-link{border:0;background:none;padding:0 0 0 6px;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer}
.sa-save-error{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary);max-width:280px;text-align:right}

/* action list */
.sa-action-row{display:flex;align-items:center;gap:8px;padding:6px 0;min-width:0}
.sa-action-row+.sa-action-row{border-top:1px solid var(--dsw-alias-border-l1)}
.sa-action-name-wrap{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.sa-action-name{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sa-action-sub{font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sa-actions-footer{display:flex;justify-content:flex-start;padding-top:10px}
.sa-actions-row{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0}
.sa-empty{margin:4px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}

/* icon badge + picker */
.sa-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1}
.sa-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer}
.sa-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sa-icon-btn:disabled{opacity:.35;cursor:default}
.sa-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-icon-picker{display:flex;flex-wrap:wrap;gap:6px}
.sa-icon-option{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;padding:5px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:10px;line-height:12px;cursor:pointer}
.sa-icon-option[aria-pressed='true']{border-color:var(--dsw-alias-brand-primary)}
.sa-icon-option-glyph{font-size:12px;line-height:16px}

/* action editor modal */
.sa-form{display:flex;flex-direction:column;gap:12px}
.sa-form-row{display:flex;gap:12px}
.sa-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.sa-field-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sa-field-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.sa-field-error{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
.sa-form-inline{display:flex;align-items:center;gap:8px}

/* log modal */
.sa-log{box-sizing:border-box;width:100%;max-height:46vh;overflow:auto;margin:0;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.sa-log-meta{margin:0 0 6px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}

/* page-level load failure */
.sa-error-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.sa-loading{padding:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}

/* advanced footer */
.sa-paths{display:flex;flex-direction:column;gap:2px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-path-line{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
`
