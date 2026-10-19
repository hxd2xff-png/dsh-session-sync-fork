window.__ModuleLoader__.load({
  id: 'dsh-session-sync',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const PANEL_ID = 'session-sync'
    const API = '/api/dsh-session-sync'
    const CLOUD = '/api/dsh-session-sync/cloud'
    const NS = 'dsh-session-sync'

    /** 顶层页签：会话备份 + 插件备份 + 技能备份。 */
    const TAB_DEFS = [
      { key: 'session', label: '会话备份' },
      { key: 'pluginbackup', label: '插件备份' },
      { key: 'skillbackup', label: '技能备份' },
    ]

    /** 文案（中英）。 */
    const zh = {
      'entry.label': '备份与同步',
      'page.title': '备份与同步',
      'page.subtitle': '会话备份/还原 + 跨设备云同步与插件同步，能力全部内置在本插件内，不依赖其他插件。',
      'status.heading': '状态',
      'status.remote': '远端',
      'status.branch': '分支',
      'status.head': '当前提交',
      'status.remoteHead': '远端提交',
      'status.aheadBehind': '领先 / 落后',
      'status.dirty': '待备份文件',
      'status.forks': '冲突留存文件',
      'status.lastBackup': '最近备份',
      'status.none': '无',
      'status.unset': '未配置',
      'status.refresh': '刷新',
      'status.loading': '读取中…',
      'config.heading': '仓库配置',
      'config.hint': '认证使用 SSH 密钥或系统 Git 凭据管理器；请勿在地址中填写明文 Token。',
      'config.remote': 'Git 仓库地址',
      'config.remotePlaceholder': 'git@github.com:你的账号/你的会话仓库.git',
      'config.branch': '分支',
      'config.save': '保存并检测',
      'config.saving': '保存中…',
      'config.saved': '已保存',
      'config.check': '检测连通性',
      'backup.heading': '手动备份',
      'backup.hint': '把本机会话镜像、提交并推送到远端；没有变化时不会产生空提交。',
      'backup.run': '立即备份',
      'backup.running': '备份中…',
      'backup.preview': '查看变更',
      'backup.nothing': '已检查，无需备份',
      'auto.heading': '自动备份',
      'auto.hint': '关闭时不会自动上传；DSH 未运行期间错过的计划不会补跑。',
      'auto.enable': '启用自动备份',
      'auto.mode.daily': '每天固定时间',
      'auto.mode.interval': '每隔一段时间',
      'auto.hour': '时',
      'auto.minute': '分',
      'auto.every': '间隔（分钟）',
      'auto.next': '下次备份',
      'auto.save': '保存计划',
      'history.heading': '备份历史',
      'history.hint': '每个提交都是一个可还原的时间点。',
      'history.empty': '暂无备份',
      'history.source.manual': '手动',
      'history.source.automatic': '自动',
      'history.source.unknown': '未知',
      'history.merge': '安全合并',
      'history.overwrite': '全量还原',
      'history.delete': '删除',
      'history.deleteConfirm': '确认删除这条备份历史吗？本地分支和 GitHub 远端将同步重写，操作不可恢复。当前会话数据不会回滚，后续备份仍会按当前状态生成。',
      'history.deleted': '备份历史已从本地与远端删除',
      'restore.previewTitle': '还原预览',
      'restore.new': '将新增',
      'restore.same': '已相同',
      'restore.fork': '将留存冲突副本',
      'restore.mergeHint': '安全合并：只补齐本地缺失的会话；同名文件保留本地版本，备份版本另存为冲突副本。',
      'restore.overwriteHint': '全量还原：用该备份恢复，同时保留本地新增历史和本地独有会话。',
      'restore.confirmOverwrite': '确认用该备份恢复，并保留本地新增历史吗？',
      'restore.overwriteRisk': '还原前保留安全快照；历史分叉或日志损坏时拒绝覆盖。备份比已加载会话更新时，需要退出并重启 DSH 后再试。',
      'restore.prepared': '已准备还原任务，请完全退出并重启 DSH 后生效。',
      'restore.pending': '有待执行的完整覆盖还原',
      'restore.cancel': '取消该还原任务',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.error': '操作失败',
    }
    const en = {
      'entry.label': 'Backup & Sync',
      'page.title': 'Backup & Sync',
      'page.subtitle': 'Session backup/restore plus cross-device cloud and plugin sync, all built into this plugin.',
      'status.heading': 'Status',
      'status.remote': 'Remote',
      'status.branch': 'Branch',
      'status.head': 'Current commit',
      'status.remoteHead': 'Remote commit',
      'status.aheadBehind': 'Ahead / behind',
      'status.dirty': 'Uncommitted files',
      'status.forks': 'Conflict copies',
      'status.lastBackup': 'Last backup',
      'status.none': 'None',
      'status.unset': 'Not configured',
      'status.refresh': 'Refresh',
      'status.loading': 'Loading…',
      'config.heading': 'Repository',
      'config.hint': 'Authentication uses SSH keys or your system Git credential helper; never put a plaintext token in the URL.',
      'config.remote': 'Git remote',
      'config.remotePlaceholder': 'git@github.com:you/your-sessions.git',
      'config.branch': 'Branch',
      'config.save': 'Save and check',
      'config.saving': 'Saving…',
      'config.saved': 'Saved',
      'config.check': 'Check connectivity',
      'backup.heading': 'Manual backup',
      'backup.hint': 'Mirror, commit and push local sessions; no changes means no empty commit.',
      'backup.run': 'Back up now',
      'backup.running': 'Backing up…',
      'backup.preview': 'Preview changes',
      'backup.nothing': 'Checked — nothing to back up',
      'auto.heading': 'Automatic backup',
      'auto.hint': 'Off never uploads; plans missed while DSH was down are not replayed.',
      'auto.enable': 'Enable automatic backup',
      'auto.mode.daily': 'Daily at a fixed time',
      'auto.mode.interval': 'Every interval',
      'auto.hour': 'Hour',
      'auto.minute': 'Minute',
      'auto.every': 'Interval (minutes)',
      'auto.next': 'Next backup',
      'auto.save': 'Save plan',
      'history.heading': 'Backup history',
      'history.hint': 'Every commit is a restorable point in time.',
      'history.empty': 'No backups yet',
      'history.source.manual': 'Manual',
      'history.source.automatic': 'Automatic',
      'history.source.unknown': 'Unknown',
      'history.merge': 'Safe merge',
      'history.overwrite': 'Full restore',
      'history.delete': 'Delete',
      'history.deleteConfirm': 'Delete this backup-history entry? The local branch and GitHub remote will be rewritten together. This cannot be undone. Current session data is not rolled back and future backups still use its current state.',
      'history.deleted': 'Backup history deleted locally and remotely',
      'restore.previewTitle': 'Restore preview',
      'restore.new': 'To add',
      'restore.same': 'Already identical',
      'restore.fork': 'Conflict copies kept',
      'restore.mergeHint': 'Safe merge: fills in sessions missing locally; same-name files keep the local version and the backup version is preserved as a conflict copy.',
      'restore.overwriteHint': 'Full restore: restore this backup while keeping newer local history and local-only sessions.',
      'restore.confirmOverwrite': 'Restore this backup and keep newer local history?',
      'restore.overwriteRisk': 'A safety snapshot is kept. Divergent or corrupt histories are rejected. If a backup is newer than a loaded session, fully quit and restart DSH before retrying.',
      'restore.prepared': 'Restore task prepared. Fully quit and restart DSH for it to take effect.',
      'restore.pending': 'A full-overwrite restore is pending',
      'restore.cancel': 'Cancel that restore task',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.error': 'Operation failed',
    }

    let locale = 'zh'
    const t = (key) => (locale === 'en' ? en[key] : zh[key]) ?? zh[key] ?? key

    /** 调后端 API；失败抛出带可读 message 的错误。 */
    async function call(path, options) {
      const opts = options ?? {}
      const response = await fetch(`${API}${path}`, {
        method: opts.method ?? 'GET',
        headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.value ?? {}
    }

    const pad = (value) => String(value).padStart(2, '0')
    function formatTime(value) {
      // 会话备份的 at 是毫秒数；云快照 history 的 createdAt 是 ISO 字符串（带 Z）。
      // 字符串先 Date.parse 成毫秒，再走本地时区渲染，保证两种来源显示一致。
      if (typeof value === 'string' && value !== '') value = Date.parse(value)
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return t('status.none')
      const date = new Date(value)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const shortSha = (sha) => (typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 8) : '—')
    const sourceLabel = (source) => (source === 'manual' ? t('history.source.manual') : source === 'automatic' ? t('history.source.automatic') : t('history.source.unknown'))

    /** 注入页面样式（一次性，带插件归属标记）。 */
    function ensureStyles() {
      const tagId = `${NS}/client.css`
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = NS
      style.dataset.pluginCss = tagId
      style.textContent = `
.ss-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;gap:14px;padding:16px 18px 24px;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:var(--dsw-font-xxs-12)}
.ss-head{display:flex;flex-direction:column;gap:4px}
.ss-title{margin:0;font-size:16px;font-weight:600}
.ss-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ss-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.ss-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ss-card-title{margin:0;font-size:13px;font-weight:600}
.ss-card-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.5}
.ss-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ss-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
.ss-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.ss-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ss-value{color:var(--dsw-alias-label-primary);font-size:12px;word-break:break-all}
.ss-value.mono{font-family:var(--ds-font-family-code,monospace);font-size:11.5px}
.ss-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .12s,border-color .12s}
.ss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-dimmed)}
.ss-btn:disabled{opacity:.45;cursor:default}
.ss-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.ss-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));border-color:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-border-l2)));color:var(--dsw-alias-label-primary-foreground,#fff)}
.ss-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ss-input{box-sizing:border-box;width:100%;height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font:inherit;font-size:12px;outline:none}
.ss-input:focus{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-border-l4))}
.ss-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.ss-note{border-radius:8px;padding:8px 10px;font-size:11.5px;line-height:1.5}
.ss-note.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.ss-note.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.ss-note.info{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ss-list{display:flex;flex-direction:column;gap:6px;max-height:380px;overflow:auto}
.ss-item{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ss-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.ss-item-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ss-badge{border-radius:999px;padding:1px 8px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ss-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:14px}
.ss-selectbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 0 6px}
.ss-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;user-select:none}
.ss-check input{accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer}
.ss-selectcount{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.ss-item.selected{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-interactive-bg-hover)}
.ss-item-head{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.ss-dialog{border:0;border-radius:14px;padding:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);max-width:520px;width:calc(100vw - 48px);box-shadow:var(--dsw-shadow-lv3)}
.ss-dialog::backdrop{background:rgba(0,0,0,.42)}
.ss-dialog-body{padding:16px 18px;display:flex;flex-direction:column;gap:12px;white-space:pre-wrap;line-height:1.6}
.ss-dialog-foot{display:flex;gap:8px;justify-content:flex-end;padding:0 18px 16px}
.ss-toggle{display:flex;align-items:center;gap:8px;font-size:12px}
/* ---- 备份进度浮层（右下角，框架层常驻）---- */
.ss-prog-dock{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:296px;pointer-events:none}
.ss-prog-row{pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:9px 11px;box-shadow:var(--dsw-shadow-lv3,0 6px 24px rgba(0,0,0,.18));display:flex;flex-direction:column;gap:7px;animation:ss-prog-in .22s cubic-bezier(.22,1,.36,1);transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .5s ease}
.ss-prog-row.is-exiting{transform:translateY(14px) scale(.86);opacity:0}
.ss-prog-head{display:flex;align-items:baseline;gap:7px;min-width:0}
.ss-prog-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ss-prog-detail{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ss-prog-pct{font-size:11px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums;margin-left:auto;padding-left:6px}
.ss-prog-badge{font-size:12px;margin-left:auto;padding-left:6px;color:var(--dsw-alias-brand-primary,#3b82f6)}
.ss-prog-row.is-error .ss-prog-badge{color:var(--dsw-alias-label-error,#ef4444)}
.ss-prog-bar{position:relative;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18));overflow:hidden}
.ss-prog-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#3b82f6);transition:width .28s linear}
.ss-prog-row.is-done .ss-prog-fill{background:var(--dsw-alias-brand-primary,#22c55e)}
.ss-prog-row.is-error .ss-prog-fill{background:var(--dsw-alias-label-error,#ef4444)}
.ss-prog-flow{position:absolute;inset:0;width:38%;border-radius:999px;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary,#3b82f6),transparent);opacity:.85;animation:ss-prog-flow 1.15s ease-in-out infinite}
@keyframes ss-prog-flow{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
@keyframes ss-prog-in{from{transform:translateY(12px) scale(.96);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.ss-prog-flow{animation-duration:2.6s}.ss-prog-row{transition:none;animation:none}}
/* ---- 插件工作区内联进度条（备份/还原/删除 busy 态）---- */
/* 复用右下角浮层的流动条纹动画，但作为按钮内的内联细条，避免占用整行。 */
.ss-inline-prog{position:relative;display:block;height:3px;width:100%;margin-top:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18));overflow:hidden}
.ss-inline-prog::after{content:'';position:absolute;inset:0;width:38%;border-radius:999px;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary,#3b82f6),transparent);opacity:.85;animation:ss-prog-flow 1.15s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.ss-inline-prog::after{animation-duration:2.6s}}
`
      document.head.append(style)
    }

    /** 字段单元。 */
    function Field(props) {
      return h('div', { className: 'ss-field' },
        h('span', { className: 'ss-label' }, props.label),
        h('span', { className: `ss-value${props.mono === true ? ' mono' : ''}` }, props.value ?? '—'),
      )
    }

    /** 提示条。 */
    function Note(props) {
      if (props.value === null || props.value === undefined) return null
      return h('div', { className: `ss-note ${props.kind}`, style: { whiteSpace: 'pre-wrap' } }, props.value)
    }

    /** 确认对话框（原生 dialog，含降级）。 */
    function ConfirmDialog(props) {
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node === null) return undefined
        if (typeof node.showModal === 'function') {
          node.showModal()
          return () => {
            if (typeof node.close === 'function' && node.open === true) node.close()
          }
        }
        return undefined
      }, [])
      return h('dialog', { className: 'ss-dialog', ref, 'aria-label': t('common.confirm'), onCancel: event => { event.preventDefault(); props.onResolve(false) } },
        h('div', { className: 'ss-dialog-body' }, props.message),
        h('div', { className: 'ss-dialog-foot' },
          h('button', { className: 'ss-btn', onClick: () => props.onResolve(false) }, t('common.cancel')),
          h('button', { className: 'ss-btn primary', onClick: () => props.onResolve(true) }, t('common.confirm')),
        ),
      )
    }

    /** 云同步结果 → 中文摘要（不直接甩 JSON 给用户）。 */
    const CLOUD_KEY_LABELS = {
      ok: '结果', error: '错误', status: '状态', provider: '提供方', type: '类型',
      gistId: 'Gist ID', token: 'Token', encrypted: '已加密', passphrase: '口令', enable: '启用加密',
      available: '有可用更新', localVersion: '本地版本', version: '远程版本', packageName: '包名', release: '更新内容',
      requestId: '请求 ID', userCode: '授权码', verificationUri: '授权页', expiresIn: '有效秒数', intervalSeconds: '轮询间隔秒',
      profile: 'Profile', remote: '远端', local: '本地', dependencies: '依赖数', bundles: 'Bundle 数',
      plugins: '插件数', configuredInRemote: '远端已配置', installed: '已安装', enabled: '已启用',
      changed: '变更数', pulled: '已拉取', pushed: '已推送', sources: '数据源', createdAt: '创建时间',
      directory: '目录', name: '名称', message: '说明', total: '总数', count: '数量', updated: '已更新',
      restored: '已还原', skipped: '已跳过', preserved: '已保留本机项', reason: '原因',
      installDeferred: '尚未安装（重启后处理）', restartRequired: '需要重启', applied: '配置已写入',
    }
    function isCloudPlain(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }
    function cloudSummary(value) {
      const rows = []
      const walk = (node, prefix) => {
        if (!isCloudPlain(node)) return
        for (const [key, val] of Object.entries(node)) {
          const label = `${prefix}${CLOUD_KEY_LABELS[key] || key}`
          if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') rows.push({ label, text: String(val) })
          else if (Array.isArray(val)) {
            rows.push({ label, text: `${val.length} 项` })
            val.forEach((item, index) => {
              if (isCloudPlain(item)) walk(item, `${label}[${index + 1}].`)
              else rows.push({ label: `${label}[${index + 1}]`, text: String(item) })
            })
          }
          else if (isCloudPlain(val)) walk(val, `${label}.`)
        }
      }
      walk(value, '')
      return rows
    }

/**
     * 插件备份页签：会话备份同款布局（状态 / 仓库配置 / 手动备份 / 自动备份 / 插件清单 / 备份历史 / 其他）。
     * 原「云提供方 / 快照同步 / 插件同步 / 云设置」四个页签的能力全部并入此处。
     */
    function PluginBackupTab(props) {
      const [status, setStatus] = useState(null)
      const [provider, setProvider] = useState(null)
      const [schedule, setSchedule] = useState(null)
      const [scheduleDraft, setScheduleDraft] = useState(null)
      const [history, setHistory] = useState(null)
      const [auth, setAuth] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const toggle = (key) => setSelected((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const toggleAll = (checked) => setSelected(checked ? new Set((Array.isArray(history) ? history : []).map(item => item.key)) : new Set())
      const [form, setForm] = useState({ gistId: '', token: '', webdavUrl: '', webdavUser: '', webdavPass: '', passphrase: '', deviceName: '', directory: '' })
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value })
      const [historyError, setHistoryError] = useState(null)

      async function callCloud(path, body) {
        const hasBody = body !== undefined
        const response = await fetch(`${props.cloud}${path}`, {
          method: hasBody ? 'POST' : 'GET',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(body) : undefined,
        })
        let payload = null
        try { payload = await response.json() } catch { throw new Error(`HTTP ${response.status}`) }
        if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        // 仅备份冲突可交给用户裁决；其他业务失败仍关闭。
        if (payload.value?.ok === false && !(path === '/snapshot/push' && payload.value.direction === 'needs-choice')) throw new Error(payload.value.error ?? '操作失败')
        return payload.value ?? {}
      }

      async function refresh() {
        setBusy('refresh')
        try {
          const results = await Promise.allSettled([
            callCloud('/inventory'), callCloud('/settings/get'),
            callCloud('/plugin-schedule/get'), callCloud('/snapshot/history'),
          ])
          const [inv, settingsResult, sched, hist] = results
          if (inv.status === 'fulfilled') setStatus(inv.value)
          if (sched.status === 'fulfilled') { setSchedule(sched.value); setScheduleDraft(sched.value) }
          if (hist.status === 'fulfilled') { setHistory(hist.value); setHistoryError(null) }
          else setHistoryError(hist.reason?.message ?? String(hist.reason))
          const failures = results.filter(item => item.status === 'rejected')
          if (failures.length > 0) setError(previous => previous ?? failures.map(item => item.reason?.message ?? String(item.reason)).join('; '))
          if (settingsResult.status !== 'fulfilled') return
          const prov = settingsResult.value
          setProvider(prov)
          setForm((f) => ({ ...f, deviceName: prov?.deviceName ?? f.deviceName }))
        } catch (e) { setError(e.message) } finally { setBusy('') }
        try { setAuth(await callCloud('/github/device/status')) } catch { /* 授权状态暂不可读，忽略 */ }
      }

      useEffect(() => { void refresh() }, [])

      async function run(label, path, body) {
        setBusy(label); setError(null); setResult(null)
        try {
          const res = await callCloud(path, body)
          if (res && typeof res === 'object' && typeof res.verificationUri === 'string' && res.verificationUri !== '') {
            try { window.open(res.verificationUri, '_blank', 'noopener') } catch { /* 弹窗被拦时用提示框按钮 */ }
          }
          setResult({ ...res, message: res.installDeferred === true || res.restartRequired === true ? '配置已还原，尚未完成安装/加载。请完全退出并重启 DSH，再检查插件安装与加载状态。' : (res.message ?? '操作已完成；详细结果见下方。') })
        } catch (e) { setError(e.message) } finally { setBusy('') }
        void refresh()
      }

      const busyAny = busy !== ''
      const ask = (message) => new Promise((resolve) => {
        if (typeof document.createElement('dialog').showModal !== 'function') {
          resolve(window.confirm(message))
          return
        }
        setConfirm({ message, resolve })
      })
      const resolveConfirm = (answer) => {
        setConfirm((current) => {
          if (current !== null) current.resolve(answer)
          return null
        })
      }
      const deleteHistoryEntry = async (item) => {
        const ok = await ask(`删除这条备份历史？\n\n${item.deviceName || '快照'} · ${item.createdAt ? formatTime(item.createdAt) : '未知时间'}\n\n远端仓库中对应的快照文件会一并删除，不可恢复。`)
        if (!ok) return
        await run(`del-${item.key}`, '/snapshot/history/delete', { snapshotKey: item.key })
      }
      // 批量：勾选多条后一次确认，串行执行（后端按次原子处理）。
      const deleteSelected = async () => {
        const keys = [...selected]
        if (keys.length === 0) return
        const ok = await ask(`删除选中的 ${keys.length} 条备份历史？\n\n远端仓库中对应的快照文件会一并删除，不可恢复。`)
        if (!ok) return
        for (const key of keys) {
          await run(`del-${key}`, '/snapshot/history/delete', { snapshotKey: key })
        }
        setSelected(new Set())
      }
      const btn = (label, key, path, body, kind) => h('button', {
        className: `ss-btn${kind ? ` ${kind}` : ''}`, disabled: busyAny,
        onClick: () => void run(key, path, body),
      }, busy === key ? '执行中…' : label)
      // 内联进度条：busy 态在按钮下方显示流动条纹，复用右下角浮层动画。
      const busyBar = (on) => on ? h('span', { className: 'ss-inline-prog', 'aria-hidden': 'true' }) : null
      // 孤儿回收：列出远端已无任何索引引用的备份对象并删除。这些是推送中途失败
      // （上传成功但索引未写入）的残留——按历史删除扫不到，只能全量比对清理。
      const reclaimOrphans = async () => {
        const ok = await ask('扫描远端孤儿对象？\n\n孤儿＝已上传但没有任何备份历史引用的残留文件（推送中途失败的产物）。\n只删除本插件前缀命名且未被引用的对象；备份历史、当前快照、其他文件一律不动。')
        if (!ok) return
        await run('reclaim', '/snapshot/reclaim-orphans', {})
      }
      // 立即备份：smart 策略遇本地/远端配置冲突时后端返回 needs-choice 且【不上传】，
      // 必须显式二次推送带 resolveConflicts，否则按钮点了没有任何备份发生（实测复现）。
      const pluginBackupNow = async () => {
        setBusy('backup'); setError(null); setResult(null)
        try {
          let res = await callCloud('/snapshot/push', {})
          if (res && res.direction === 'needs-choice') {
            const conflicts = Array.isArray(res.conflicts) ? res.conflicts : []
            const list = conflicts.slice(0, 5).map((c) => `· ${c.profile ?? ''}/${c.key ?? ''}`).join('\n')
            const keepLocal = await ask(`本机与远端插件配置有 ${conflicts.length} 处不一致：\n${list}${conflicts.length > 5 ? '\n…' : ''}\n\n确定＝以本机当前配置为准完成备份；\n取消＝停止备份，不上传。`)
            if (!keepLocal) return
            res = await callCloud('/snapshot/push', { resolveConflicts: 'local' })
          }
          setResult({ message: '操作已完成；详细结果见下方。', ...res })
        } catch (e) { setError(e.message) } finally { setBusy('') }
        void refresh()
      }
      const restorePluginSnapshot = async (item) => {
        const target = item ? `${item.deviceName || '快照'} · ${item.createdAt ? formatTime(item.createdAt) : '未知时间'}` : '远端最新快照'
        const ok = await ask(`还原插件配置？\n\n${target}\n\n将写入备份包含的各 Profile 配置及插件源目录；本机独有依赖保留，不可用项跳过。插件依赖不会立即安装或加载，请完全退出并重启 DSH 后检查安装与加载状态。\n取消不会还原。`)
        if (!ok) return
        await run('pull', '/snapshot/pull', { skipUnavailable: true, apply: true, ...(item ? { snapshotKey: item.key } : {}) })
      }
      const plugins = Array.isArray(status?.plugins) ? status.plugins : []
      const configured = plugins.filter((p) => p.configuredInRemote === true).length
      const installedCount = plugins.filter((p) => p.installed === true).length
      const providerType = provider?.provider?.type ?? '未配置'
      const remoteAvailable = status?.remote?.available === true
      const lastRun = schedule?.lastRunAt ? formatTime(schedule.lastRunAt) : '—'

      return h('div', { className: 'ss-tab-body' }, [

        // 插件状态
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, '插件状态'),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void refresh() }, busy === 'refresh' ? '读取中…' : '刷新'),
            ),
          ),
          h('div', { className: 'ss-grid' },
            h(Field, { label: 'Profile', value: status?.profile ?? '—', mono: true }),
            h(Field, { label: '仓库类型', value: providerType, mono: true }),
            h(Field, { label: '远端可用', value: status == null ? '尚未读取' : remoteAvailable ? '是' : '否' }),
            status?.remote?.error ? h(Field, { label: '远端读取失败原因', value: status.remote.error }) : null,
            h(Field, { label: '本地 Bundle', value: String(status?.local?.bundles ?? 0) }),
            h(Field, { label: '已配置插件', value: String(configured) }),
            h(Field, { label: '已安装插件', value: String(installedCount) }),
            h(Field, { label: '上次备份', value: lastRun }),
            h(Field, { label: 'GitHub 授权', value: auth?.authorized === true || auth?.configured === true ? '已授权' : '未授权' }),
          ),
          error ? h('div', { className: 'ss-note error' }, error) : null,
          result && typeof result === 'object' && typeof result.userCode === 'string' && result.userCode !== ''
            ? h('div', { className: 'ss-note info' },
                h('div', null, `请在浏览器打开授权页并输入代码：${result.userCode}`),
                h('button', { className: 'ss-btn', onClick: () => { try { window.open(result.verificationUri, '_blank', 'noopener') } catch { /* 忽略拦截 */ } } }, '打开授权页'),
              )
            : null,
          result?.installDeferred === true || result?.restartRequired === true ? h('div', { className: 'ss-note info', role: 'status' }, result.message) : null,
          result === null ? null : h('div', { className: 'ss-card-result' },
            h('div', { className: 'ss-list' },
              cloudSummary(result).map((row) => h('div', { className: 'ss-item', key: `${row.label}-${row.text}` },
                h('div', { className: 'ss-item-main' },
                  h('span', { className: 'ss-label' }, row.label),
                  h('span', { className: 'ss-value' }, row.text),
                ),
              )),
            ),
            h('details', { style: { marginTop: '8px' } },
              h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, '查看原始 JSON'),
              h('pre', { className: 'ss-pre', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '180px', overflow: 'auto', marginTop: '6px' } }, JSON.stringify(result, null, 2)),
            ),
          ),
        ),

        // 仓库配置（原「云提供方」页签能力并入）
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '仓库配置')),
          h('p', { className: 'ss-card-hint' }, '插件备份推送到的远端仓库（GitHub Gist / WebDAV / S3），会话备份与插件备份共用。'),
          h('div', { className: 'ss-grid' },
            h(Field, { label: '提供方', value: providerType, mono: true }),
            h(Field, { label: 'Gist ID', value: provider?.provider?.gistId || '—', mono: true }),
            h(Field, { label: '加密', value: provider == null ? '尚未读取' : provider.encryption?.enabled === true ? (provider.encryption.unlocked === true ? '已启用且已解锁' : '已启用但已锁定') : provider.encryption?.enabled === false ? '未启用' : '状态未知' }),
            h(Field, { label: '设备名', value: provider?.deviceName ?? '—' }),
            h('div', { className: 'ss-field' },
              h('span', { className: 'ss-label' }, '\u00a0'),
              h('div', { className: 'ss-row' },
                btn('GitHub 设备授权', 'ghStart', '/github/device/start'),
                btn('轮询授权结果', 'ghPoll', '/github/device/poll', { requestId: auth?.requestId ?? result?.requestId ?? '' }),
                btn('清除提供方', 'clear', '/settings/clear-provider', undefined, 'danger'),
              ),
            ),
          ),
          h('details', { style: { marginTop: '8px' } },
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, '手动配置仓库（PAT / WebDAV / S3 / 加密 / 设备名）'),
            h('div', { className: 'ss-grid', style: { marginTop: '8px' } },
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, 'Gist ID'), h('input', { className: 'ss-input', value: form.gistId, onChange: set('gistId'), spellCheck: false })),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, 'GitHub Token（PAT）'), h('input', { className: 'ss-input', type: 'password', value: form.token, onChange: set('token') })),
              h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
                h('div', { className: 'ss-row' }, btn('连接 GitHub Gist', 'gist', '/provider/connect', { provider: { type: 'gist', gistId: form.gistId, token: form.token } }, 'primary')),
              ),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, 'WebDAV URL'), h('input', { className: 'ss-input', value: form.webdavUrl, onChange: set('webdavUrl'), spellCheck: false })),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, 'WebDAV 用户'), h('input', { className: 'ss-input', value: form.webdavUser, onChange: set('webdavUser') })),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, 'WebDAV 密码'), h('input', { className: 'ss-input', type: 'password', value: form.webdavPass, onChange: set('webdavPass') })),
              h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
                h('div', { className: 'ss-row' }, btn('连接 WebDAV', 'webdav', '/webdav/connect', { provider: 'webdav', url: form.webdavUrl, username: form.webdavUser, password: form.webdavPass }, 'primary')),
              ),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, '解密口令（解锁加密）'), h('input', { className: 'ss-input', type: 'password', value: form.passphrase, onChange: set('passphrase') })),
              h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
                h('div', { className: 'ss-row' },
                  btn('解锁加密', 'unlock', '/security/unlock', { passphrase: form.passphrase, enable: false }),
                  btn('锁定加密', 'lock', '/security/lock'),
                ),
              ),
              h('div', { className: 'ss-field' }, h('span', { className: 'ss-label' }, '设备名（同步偏好）'), h('input', { className: 'ss-input', value: form.deviceName, onChange: set('deviceName') })),
              h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
                h('div', { className: 'ss-row' },
                  btn('保存设备名', 'prefs', '/settings/preferences', { deviceName: form.deviceName }),
                  h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void restorePluginSnapshot() }, [ '从远端拉取快照', busyBar(busy === 'pull') ]),
                ),
              ),
            ),
          ),
        ),

        // 手动备份
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, '手动备份'),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void run('diff', '/snapshot/diff') }, '预览差异'),
              h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: () => void pluginBackupNow() }, [ busy === 'backup' ? '备份中…' : '立即备份', busyBar(busy === 'backup') ]),
            ),
          ),
          h('p', { className: 'ss-card-hint' }, '把本机插件清单（含版本与 Bundle）推送到远端快照，其他设备可一键安装。'),
        ),

        // 自动备份
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '自动备份')),
          h('p', { className: 'ss-card-hint' }, '开启后按固定时间或间隔自动推送插件清单。'),
          scheduleDraft === null ? null : h('div', { className: 'ss-grid' },
            h('label', { className: 'ss-toggle' },
              h('input', {
                type: 'checkbox', checked: scheduleDraft.enabled === true,
                onChange: (event) => setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked }),
              }),
              h('span', null, '启用自动备份'),
            ),
            h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
              h('span', { className: 'ss-label' }, '每天固定时间 / 每隔一段时间'),
              h('select', {
                className: 'ss-input', value: scheduleDraft.mode,
                onChange: (event) => setScheduleDraft({ ...scheduleDraft, mode: event.target.value }),
              },
                h('option', { value: 'daily' }, '每天固定时间'),
                h('option', { value: 'interval' }, '每隔一段时间'),
              ),
            ),
            scheduleDraft.mode === 'interval'
              ? h('div', { className: 'ss-field' },
                  h('span', { className: 'ss-label' }, '间隔（分钟）'),
                  h('input', {
                    className: 'ss-input', type: 'number', min: '5', max: '10080', value: String(scheduleDraft.everyMinutes ?? 60),
                    onChange: (event) => setScheduleDraft({ ...scheduleDraft, everyMinutes: event.target.value }),
                  }),
                )
              : h('div', { className: 'ss-row', style: { gridColumn: '1 / -1' } },
                  h('div', { className: 'ss-field', style: { flex: '0 0 100px' } },
                    h('span', { className: 'ss-label' }, '时'),
                    h('input', {
                      className: 'ss-input', type: 'number', min: '0', max: '23', value: String(scheduleDraft.atHour ?? 3),
                      onChange: (event) => setScheduleDraft({ ...scheduleDraft, atHour: event.target.value }),
                    }),
                  ),
                  h('div', { className: 'ss-field', style: { flex: '0 0 100px' } },
                    h('span', { className: 'ss-label' }, '分'),
                    h('input', {
                      className: 'ss-input', type: 'number', min: '0', max: '59', value: String(scheduleDraft.atMinute ?? 0),
                      onChange: (event) => setScheduleDraft({ ...scheduleDraft, atMinute: event.target.value }),
                    }),
                  ),
                ),
            h(Field, { label: '上次备份', value: lastRun }),
            h('div', { className: 'ss-field' },
              h('span', { className: 'ss-label' }, '\u00a0'),
              h('div', { className: 'ss-row' },
                h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: () => void run('save', '/plugin-schedule/set', scheduleDraft) }, busy === 'save' ? '保存中…' : '保存'),
              ),
            ),
          ),
        ),

        // 插件清单（原「插件同步」页签能力并入）
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '插件清单')),
          h('p', { className: 'ss-card-hint' }, '本地与远端清单对比；远端已配置的插件可一键安装/采用/卸载。'),
          h('div', { className: 'ss-list', style: { maxHeight: '320px', overflow: 'auto' } },
            plugins.length === 0
              ? h('div', { className: 'ss-empty' }, '暂无插件')
              : plugins.map((plugin) => h('div', { className: 'ss-item', key: plugin.name },
                  h('div', { className: 'ss-item-main' },
                    h('span', { className: 'ss-value', style: { wordBreak: 'break-all' } }, plugin.name),
                    h('span', { className: 'ss-item-sub' }, [
                      plugin.installed === true ? '已安装' : '未安装',
                      plugin.enabled === true ? '已启用' : null,
                      plugin.configuredInRemote === true ? '远端已配置' : null,
                    ].filter(Boolean).join(' · ')),
                  ),
                  plugin.configuredInRemote === true && plugin.installed !== true
                    ? h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void run(`inst-${plugin.name}`, '/plugin/install-configured', { packageName: plugin.name }) }, busy === `inst-${plugin.name}` ? '执行中…' : '安装')
                    : null,
                  plugin.configurationOnly === true && plugin.installed !== true
                    ? h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void run(`adopt-${plugin.name}`, '/plugin/adopt-configured', { packageName: plugin.name }) }, busy === `adopt-${plugin.name}` ? '执行中…' : '采用')
                    : null,
                  plugin.installed === true
                    ? h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void run(`un-${plugin.name}`, '/plugin/uninstall', { packageName: plugin.name }) }, busy === `un-${plugin.name}` ? '执行中…' : '卸载')
                    : null,
                )),
          ),
        ),

        // 备份历史
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '备份历史')),
          h('p', { className: 'ss-card-hint' }, '远端快照历史，可还原到某个版本；支持勾选多条批量删除。'),
          h(HistoryMultiSelect, { total: history?.length ?? 0, selected, onToggleAll: toggleAll }),
          selected.size > 0 ? h('div', { className: 'ss-actions', style: { paddingBottom: '6px' } },
            h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteSelected() }, [ `批量删除 (${selected.size})`, busyBar(typeof busy === 'string' && busy.startsWith('del-')) ]),
          ) : null,
          h('div', { className: 'ss-list' },
            historyError ? h('div', { className: 'ss-note error', role: 'alert' }, `备份历史读取失败：${historyError}。请点击刷新重试；已读取的历史仍保留。`) : null,
            !history || (Array.isArray(history) ? history.length === 0 : true)
              ? (historyError ? null : h('div', { className: 'ss-empty' }, history === null ? '正在读取备份历史…' : '暂无备份历史'))
              : history.map((item) => {
                  // core 的 changes 是 diffSnapshots 返回的对象数组（{kind:'plugin'|'config'|'source',...}），
                  // 直接拼字符串会变成 [object Object]×N —— 必须按 kind 统计后渲染。
                  const changes = Array.isArray(item.changes) ? item.changes : []
                  const countOf = (kind) => changes.filter((c) => c?.kind === kind).length
                  const parts = [
                    countOf('plugin') > 0 ? `插件 ${countOf('plugin')}` : null,
                    countOf('config') > 0 ? `配置 ${countOf('config')}` : null,
                    countOf('source') > 0 ? `源 ${countOf('source')}` : null,
                  ].filter(Boolean)
                  const detail = parts.length === 0 ? '无变更' : parts.join(' · ')
                  const isSelected = selected.has(item.key)
                  return h('div', { className: `ss-item${isSelected ? ' selected' : ''}`, key: item.key },
                    h('div', { className: 'ss-item-head' },
                      h('label', { className: 'ss-check' },
                        h('input', { type: 'checkbox', checked: isSelected, onChange: () => toggle(item.key) }),
                      ),
                      h('div', { className: 'ss-item-main' },
                        h('span', null, `${item.deviceName || '快照'} · ${detail}`),
                        h('span', { className: 'ss-item-sub' }, `${item.createdAt ? formatTime(item.createdAt) : ''}`),
                      ),
                    ),
                    h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void restorePluginSnapshot(item) }, [ busy === 'pull' ? '还原中…' : '还原', busyBar(busy === 'pull') ]),
                    h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteHistoryEntry(item) }, [ busy === `del-${item.key}` ? '删除中…' : '删除', busyBar(busy === `del-${item.key}`) ]),
                  )
                }),
          ),
        ),

        // 其他（原「云设置」页签里不属于备份的能力）
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '其他')),
          h('div', { className: 'ss-grid' },
            h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
              h('div', { className: 'ss-row' },
                btn('检查本插件更新', 'release', '/release/check'),
                h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void reclaimOrphans() }, busy === 'reclaim' ? '执行中…' : '回收孤儿对象'),
                h('div', { className: 'ss-field', style: { flex: '1 1 220px' } }, h('input', { className: 'ss-input', placeholder: '本地插件源目录', value: form.directory, onChange: set('directory'), spellCheck: false })),
                btn('备份插件源目录', 'srcBak', '/source/backup', { directory: form.directory }),
              ),
            ),
          ),
        ),

        confirm !== null ? h(ConfirmDialog, { message: confirm.message, onResolve: resolveConfirm }) : null,
      ])
    }

    /**
     * 技能备份页签：备份全局技能库（~/.agents/skills）到远端仓库。
     * 与插件备份同构：状态 / 手动备份 / 本地技能清单 / 备份历史（可还原、可删除）。
     * 远端键空间独立（skills/ 前缀），删除不影响会话与插件备份历史。
     */
    function SkillBackupTab(props) {
      const [local, setLocal] = useState(null)
      const [history, setHistory] = useState(null)
      const [provider, setProvider] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const toggle = (key) => setSelected((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const toggleAll = (checked) => setSelected(checked ? new Set((Array.isArray(history) ? history : []).map(item => item.key)) : new Set())

      async function callCloud(path, body) {
        const hasBody = body !== undefined
        const response = await fetch(`${props.cloud}${path}`, {
          method: hasBody ? 'POST' : 'GET',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(body) : undefined,
        })
        let payload = null
        try { payload = await response.json() } catch { throw new Error(`HTTP ${response.status}`) }
        if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        if (payload.value?.ok === false) throw new Error(payload.value.error ?? '操作失败')
        return payload.value ?? {}
      }

      async function refresh() {
        setBusy('refresh')
        try {
          const [skills, hist, prov] = await Promise.all([
            callCloud('/skill/local-list'), callCloud('/skill/history'), callCloud('/settings/get'),
          ])
          setLocal(skills); setHistory(hist); setProvider(prov)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }

      useEffect(() => { void refresh() }, [])

      async function run(label, path, body) {
        setBusy(label); setError(null); setResult(null)
        try {
          const res = await callCloud(path, body)
          setResult({ message: '操作已完成；详细结果见下方。', ...res })
        } catch (e) { setError(e.message) } finally { setBusy('') }
        void refresh()
      }

      const busyAny = busy !== ''
      const ask = (message) => new Promise((resolve) => {
        if (typeof document.createElement('dialog').showModal !== 'function') {
          resolve(window.confirm(message))
          return
        }
        setConfirm({ message, resolve })
      })
      const resolveConfirm = (answer) => {
        setConfirm((current) => {
          if (current !== null) current.resolve(answer)
          return null
        })
      }
      const describeBackup = (item) => {
        const skills = Array.isArray(item.skills) ? item.skills : (typeof item.name === 'string' ? [item.name] : [])
        const total = typeof item.total === 'number' ? item.total : skills.length
        const parts = typeof item.parts === 'number' ? item.parts : 1
        return `${total} 个技能 · ${parts} 个分片 · ${bytes(item.sourceBytes)}`
      }
      const deleteBackup = async (item) => {
        const ok = await ask(`删除这次技能备份？\n\n${describeBackup(item)}\n${item.createdAt ? formatTime(item.createdAt) : '未知时间'}\n\n远端仓库中这次备份的全部分片会一并删除，不可恢复。`)
        if (!ok) return
        await run(`del-${item.key}`, '/skill/history/delete', { skillKey: item.key })
      }
      const restoreBackup = async (item) => {
        const ok = await ask(`还原这次技能备份到本地技能库？\n\n${describeBackup(item)}\n\n已存在的同名技能会被跳过，不会被覆盖。`)
        if (!ok) return
        await run(`restore-${item.key}`, '/skill/restore', { skillKeys: [item.key] })
      }
      // 批量：勾选多条后一次确认，串行执行（后端按次原子处理）。
      const deleteSelected = async () => {
        const keys = [...selected]
        if (keys.length === 0) return
        const ok = await ask(`删除选中的 ${keys.length} 次技能备份？\n\n远端仓库中这些备份的全部分片会一并删除，不可恢复。`)
        if (!ok) return
        for (const key of keys) {
          await run(`del-${key}`, '/skill/history/delete', { skillKey: key })
        }
        setSelected(new Set())
      }
      const restoreSelected = async () => {
        const keys = [...selected]
        if (keys.length === 0) return
        const ok = await ask(`还原选中的 ${keys.length} 次技能备份到本地技能库？\n\n已存在的同名技能会被跳过，不会被覆盖。`)
        if (!ok) return
        await run('restore-selected', '/skill/restore', { skillKeys: keys })
        setSelected(new Set())
      }
      const skills = Array.isArray(local) ? local : (Array.isArray(local?.skills) ? local.skills : [])
      const entries = Array.isArray(history) ? history : []
      const providerType = provider?.provider?.type ?? '未配置'
      const bytes = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.max(1, Math.round(value / 1024))} KB` : '—')

      return h('div', { className: 'ss-tab-body' }, [

        // 技能库状态
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, '技能库状态'),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void refresh() }, busy === 'refresh' ? '读取中…' : '刷新'),
            ),
          ),
          h('div', { className: 'ss-grid' },
            h(Field, { label: '本地技能数', value: String(skills.length) }),
            h(Field, { label: '仓库类型', value: providerType, mono: true }),
            h(Field, { label: '远端备份数', value: String(entries.length) }),
          ),
          h('p', { className: 'ss-card-hint' }, '备份范围为全局技能库（~/.agents/skills），与 DSH Profile 无关；每个技能一个独立归档，可单独删除或还原。'),
          error ? h('div', { className: 'ss-note error' }, error) : null,
          result === null ? null : h('div', { className: 'ss-card-result' },
            h('div', { className: 'ss-list' },
              cloudSummary(result).map((row) => h('div', { className: 'ss-item', key: `${row.label}-${row.text}` },
                h('div', { className: 'ss-item-main' },
                  h('span', { className: 'ss-label' }, row.label),
                  h('span', { className: 'ss-value' }, row.text),
                ),
              )),
            ),
          ),
        ),

        // 手动备份
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, '手动备份'),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: () => void run('backup', '/skill/push', {}) }, busy === 'backup' ? '备份中…' : '立即备份'),
            ),
          ),
          h('p', { className: 'ss-card-hint' }, '把本地技能库推送到远端仓库；已存在同名技能的归档会按内容哈希覆盖，未变化的技能复用同一对象。'),
        ),

        // 本地技能清单
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '本地技能')),
          h('div', { className: 'ss-list', style: { maxHeight: '320px', overflow: 'auto' } },
            skills.length === 0
              ? h('div', { className: 'ss-empty' }, '暂无本地技能')
              : skills.map((skill) => h('div', { className: 'ss-item', key: skill.name ?? skill },
                  h('div', { className: 'ss-item-main' },
                    h('span', { className: 'ss-value', style: { wordBreak: 'break-all' } }, skill.name ?? skill),
                  ),
                )),
          ),
        ),

        // 备份历史（一次备份 = 一条历史，内含该次所有技能与分片；支持多选批量操作）
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, '备份历史')),
          h('p', { className: 'ss-card-hint' }, '每次备份一条历史（内含该次全部技能与分片），可勾选多条后批量还原或删除。'),
          entries.length === 0 ? null : h(HistoryMultiSelect, { total: entries.length, selected, onToggleAll: toggleAll }),
          selected.size > 0 ? h('div', { className: 'ss-actions', style: { paddingBottom: '6px' } },
            h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void restoreSelected() }, `批量还原 (${selected.size})`),
            h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteSelected() }, `批量删除 (${selected.size})`),
          ) : null,
          h('div', { className: 'ss-list', style: { maxHeight: '360px', overflow: 'auto' } },
            entries.length === 0
              ? h('div', { className: 'ss-empty' }, '暂无备份历史')
              : entries.map((item) => {
                  const skills = Array.isArray(item.skills) ? item.skills : (typeof item.name === 'string' ? [item.name] : [])
                  const total = typeof item.total === 'number' ? item.total : skills.length
                  const parts = typeof item.parts === 'number' ? item.parts : 1
                  const isSelected = selected.has(item.key)
                  return h('div', { className: `ss-item${isSelected ? ' selected' : ''}`, key: item.key },
                    h('div', { className: 'ss-item-head' },
                      h('label', { className: 'ss-check' },
                        h('input', { type: 'checkbox', checked: isSelected, onChange: () => toggle(item.key) }),
                      ),
                      h('div', { className: 'ss-item-main' },
                        h('span', null, `${total} 个技能 · ${parts} 个分片 · ${bytes(item.sourceBytes)}`),
                        h('span', { className: 'ss-item-sub' }, `${item.deviceName ? `${item.deviceName} · ` : ''}${item.createdAt ? formatTime(item.createdAt) : ''}`),
                      ),
                    ),
                    h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void restoreBackup(item) }, busy === `restore-${item.key}` ? '还原中…' : '还原'),
                    h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteBackup(item) }, busy === `del-${item.key}` ? '删除中…' : '删除'),
                  )
                }),
          ),
        ),

        confirm !== null ? h(ConfirmDialog, { message: confirm.message, onResolve: resolveConfirm }) : null,
      ])
    }

    /** 历史行多选控件：复选框 + 全选/反选，供三个页签的历史列表复用。 */
    function HistoryMultiSelect(props) {
      const { total, selected, onToggleAll } = props
      const allSelected = total > 0 && selected.size === total
      return h('div', { className: 'ss-selectbar' },
        h('label', { className: 'ss-check' },
          h('input', {
            type: 'checkbox', checked: allSelected,
            onChange: (event) => onToggleAll(event.target.checked),
          }),
          h('span', null, allSelected ? '取消全选' : '全选'),
        ),
        h('span', { className: 'ss-selectcount' }, `已选 ${selected.size} / ${total}`),
      )
    }

    /** Confirm local absolute-path mappings; missing project directories remain pending. */
    function ProjectPathDialog({ projects, onResolve }) {
      const ref = useRef(null)
      const [paths, setPaths] = useState(() => Object.fromEntries(projects.map(item => [item.source, item.target || item.suggested || item.source || ''])))
      useEffect(() => {
        const node = ref.current
        if (typeof node?.showModal === 'function') node.showModal()
        else node?.setAttribute('open', '')
        return () => { if (node?.open && typeof node.close === 'function') node.close() }
      }, [])
      return h('dialog', { ref, className: 'ss-dialog', 'aria-label': '确认目标设备项目目录', onCancel: event => { event.preventDefault(); onResolve(null) } },
        h('form', { onSubmit: event => { event.preventDefault(); onResolve(paths) } },
          h('div', { className: 'ss-dialog-body', style: { maxHeight: '60vh', overflow: 'auto' } },
            h('strong', null, '确认目标设备的本地项目目录'),
            h('p', { className: 'ss-card-hint' }, '请核对本机绝对路径，也可保留原路径。目标目录可以尚不存在；日志仍会恢复，分组列为待处理，不会自动创建项目目录。这里只还原会话历史，不包含项目文件。'),
            projects.map((item, index) => h('label', { key: item.source, className: 'ss-field', htmlFor: 'ss-restore-path-' + index },
              h('span', { className: 'ss-label' }, item.source),
              h('input', { id: 'ss-restore-path-' + index, className: 'ss-input', required: true, spellCheck: false, value: paths[item.source], onChange: event => setPaths(current => ({ ...current, [item.source]: event.target.value })) }),
              item.requiresSelection ? h('span', { className: 'ss-item-sub' }, '目录尚不存在：可保留此路径继续恢复日志，工作区分组待处理；也可填写本机其他绝对路径。') : null,
            )),
          ),
          h('div', { className: 'ss-dialog-foot' },
            h('button', { type: 'button', className: 'ss-btn', onClick: () => onResolve(null) }, t('common.cancel')),
            h('button', { type: 'submit', className: 'ss-btn primary' }, '核对目录并继续'),
          ),
        ),
      )
    }

    /** 主页面。 */
    function SessionSyncPage() {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState({ remote: '', branch: 'main' })
      const [schedule, setSchedule] = useState(null)
      const [operation, setOperation] = useState(null)
      const [history, setHistory] = useState([])
      const [pending, setPending] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState('')
      const [remoteDraft, setRemoteDraft] = useState('')
      const [branchDraft, setBranchDraft] = useState('main')
      const [scheduleDraft, setScheduleDraft] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [tab, setTab] = useState('session')
      const [projectDialog, setProjectDialog] = useState(null)
      const [authModeDraft, setAuthModeDraft] = useState('system')
      const [sshKeyDraft, setSshKeyDraft] = useState('')
      const [historyError, setHistoryError] = useState(null)
      const projectResolve = useRef(null)
      useEffect(() => () => { projectResolve.current?.(null) }, [])
      const toggle = (sha) => setSelected((current) => {
        const next = new Set(current)
        if (next.has(sha)) next.delete(sha)
        else next.add(sha)
        return next
      })
      const toggleAll = (checked) => setSelected(checked ? new Set(history.map(commit => commit.sha)) : new Set())

      const refresh = useCallback(async () => {
        const value = await call('/status')
        setStatus(value.status ?? null)
        setConfig(value.config ?? { remote: '', branch: 'main' })
        setSchedule(value.schedule ?? null)
        setOperation(value.operation ?? null)
        return value
      }, [])

      const refreshHistory = useCallback(async () => {
        try {
          const value = await call('/history?limit=50')
          if (value.history?.ok === false) throw new Error(value.history.error ?? '备份历史同步失败')
          setHistory(value.history?.commits ?? [])
          setHistoryError(null)
        } catch (error) {
          setHistoryError(error.message)
          throw error
        }
      }, [])

      const refreshPending = useCallback(async () => {
        try {
          const value = await call('/restore/pending')
          setPending(value.pending?.pending ?? null)
        } catch {
          setPending(null)
        }
      }, [])

      // 首屏加载；各请求独立失败，不互相阻断。
      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const value = await refresh()
            if (!alive) return
            setRemoteDraft(value.config?.remote ?? '')
            setBranchDraft(value.config?.branch ?? 'main')
            setAuthModeDraft(value.config?.authMode ?? 'system')
            setSshKeyDraft(value.config?.sshKeyPath ?? '')
            setScheduleDraft(value.schedule ?? null)
          } catch (error) {
            if (alive) setNote({ kind: 'error', value: error.message })
          }
          try {
            await refreshHistory()
          } catch (error) {
            // refreshHistory 已记录错误；保留已读取的历史，不伪装空备份。
          }
          await refreshPending()
        })()
        return () => {
          alive = false
        }
      }, [refresh, refreshHistory, refreshPending])

      // Poll remote backup objects while this page is visible. Schedule only after
      // completion so slow fetches cannot accumulate background requests.
      useEffect(() => {
        let stopped = false
        let timer
        const tick = async () => {
          try {
            if (document.visibilityState !== 'hidden') await refreshHistory()
          } catch {
            // refreshHistory retains the last successful list and exposes the error.
          } finally {
            if (!stopped) timer = setTimeout(tick, 60_000)
          }
        }
        timer = setTimeout(tick, 60_000)
        return () => { stopped = true; clearTimeout(timer) }
      }, [refreshHistory])

      /** 统一忙碌包装。 */
      const run = useCallback(async (key, fn) => {
        setBusy(key)
        setNote(null)
        try {
          return await fn()
        } catch (error) {
          setNote({ kind: 'error', value: `${t('common.error')}: ${error.message}` })
          return null
        } finally {
          setBusy('')
        }
      }, [])

      /** 询问确认。 */
      const ask = useCallback((message) => new Promise((resolve) => {
        if (typeof document.createElement('dialog').showModal !== 'function') {
          resolve(window.confirm(message))
          return
        }
        setConfirm({ message, resolve })
      }), [])

      const resolveConfirm = useCallback((answer) => {
        setConfirm((current) => {
          if (current !== null) current.resolve(answer)
          return null
        })
      }, [])

      const onSave = () => run('save', async () => {
        const value = await call('/settings', { method: 'POST', body: { remote: remoteDraft, branch: branchDraft, authMode: authModeDraft, sshKeyPath: sshKeyDraft } })
        setConfig(value.config ?? config)
        setSchedule(value.schedule ?? schedule)
        await refresh()
        setNote({ kind: 'ok', value: t('config.saved') })
      })

      const onCheck = () => run('check', async () => {
        const value = await call('/remote/check', { method: 'POST' })
        const check = value.check ?? {}
        setNote({ kind: check.ok === false ? 'error' : 'ok', value: check.detail ?? check.error ?? t('config.saved') })
      })

      const onBackup = () => run('backup', async () => {
        const previewValue = await call('/backup/preview', { method: 'POST' })
        const preview = previewValue.preview ?? {}
        if (preview.nothingToDo === true) {
          setNote({ kind: 'ok', value: t('backup.nothing') })
          return
        }
        const ok = await ask(`${t('backup.run')}?\n${t('backup.hint')}\n\n${t('status.dirty')}: ${preview.dirtyCount ?? 0}`)
        if (!ok) return
        const result = await call('/backup/run', { method: 'POST' })
        const summary = result.result ?? {}
        setNote({ kind: 'ok', value: `${t('backup.run')} ✓ ${shortSha(summary.head)}` })
        await refresh()
        await refreshHistory()
      })

      const onPreview = () => run('preview', async () => {
        const value = await call('/backup/preview', { method: 'POST' })
        const preview = value.preview ?? {}
        setNote({ kind: 'info', value: `${t('status.dirty')}: ${preview.dirtyCount ?? 0} · ${t('status.aheadBehind')} ${preview.ahead ?? 0} / ${preview.behind ?? 0}` })
      })

      const onSaveSchedule = () => run('schedule', async () => {
        const draft = scheduleDraft ?? schedule ?? {}
        const value = await call('/settings', {
          method: 'POST',
          body: {
            schedule: {
              enabled: draft.enabled === true,
              mode: draft.mode === 'interval' ? 'interval' : 'daily',
              atHour: Number.parseInt(String(draft.atHour ?? 3), 10),
              atMinute: Number.parseInt(String(draft.atMinute ?? 0), 10),
              everyMinutes: Number.parseInt(String(draft.everyMinutes ?? 60), 10),
            },
          },
        })
        setSchedule(value.schedule ?? null)
        setScheduleDraft(value.schedule ?? null)
        setNote({ kind: 'ok', value: t('config.saved') })
      })

      const restorePaths = async (commit) => {
        let projectPaths = {}
        let value = await call('/restore/preview', { method: 'POST', body: { commit: commit.sha } })
        let preview = value.preview ?? {}
        if (preview.ok === false) throw new Error(preview.error)
        const projects = preview.projects ?? []
        if (projects.some(item => item.source !== (item.target || item.suggested || item.source))) {
          projectPaths = await new Promise(resolve => { projectResolve.current = resolve; setProjectDialog(projects) })
          if (projectPaths === null) return null
          value = await call('/restore/preview', { method: 'POST', body: { commit: commit.sha, projectPaths } })
          preview = value.preview ?? {}
          if (preview.ok === false) throw new Error(preview.error)
        }
        return { preview, projectPaths }
      }
      const resolveProjectDialog = answer => {
        const resolve = projectResolve.current
        projectResolve.current = null
        setProjectDialog(null)
        resolve?.(answer)
      }

      // 分组计数均为会话数，不把日志成功等同工作区注册成功。
      const groupsOf = value => value?.groups ?? value?.workspaceRestore
      const groupsNeedAttention = groups => groups != null && ((groups.pending?.length ?? 0) > 0 || (groups.warnings?.length ?? 0) > 0 || groups.legacy === true)
      const groupsSummary = (groups, preview = false) => {
        if (groups == null) return '\n工作区分组：未返回结果，尚未验证。'
        const pending = Array.isArray(groups.pending) ? groups.pending : []
        const warnings = Array.isArray(groups.warnings) ? groups.warnings : []
        const lines = [preview
          ? `工作区分组预览（会话数）：可挂接 ${groups.ready ?? 0} · 保留现有归属 ${groups.preserved ?? 0} · 待处理 ${pending.length} · 原本无分组 ${groups.ungrouped ?? 0}`
          : `工作区分组（会话数）：已挂接 ${groups.restored ?? 0} · 保留现有归属 ${groups.preserved ?? 0} · 待处理 ${pending.length} · 原本无分组 ${groups.ungrouped ?? 0}`]
        if (groups.legacy === true) lines.push('旧备份未包含原工作区名称；仅按 cwd 重建，原自定义名称无法恢复。')
        lines.push('同路径的本机现有工作区名称保留，不覆盖。')
        if (pending.length > 0) {
          lines.push('日志可恢复，但这些分组待处理，侧栏可能暂不可见；不会自动创建项目目录。')
          lines.push(...pending.slice(0, 5).map(item => `${item.path || item.sourcePath || item.id}：${item.reason || '待处理'}`))
          if (pending.length > 5) lines.push(`另有 ${pending.length - 5} 个会话待处理。`)
        }
        lines.push(...warnings.slice(0, 5))
        if (warnings.length > 5) lines.push(`另有 ${warnings.length - 5} 条警告。`)
        return '\n' + lines.join('\n')
      }
      const artifactPreview = preview => (preview.auxiliaryCount ?? 0) === 0 ? '' : '\n\n' +
        (locale === 'en' ? 'Auxiliary backup files will be preserved separately, not opened as sessions: ' : '附属备份将原样另存，不作为正式会话打开：') +
        preview.auxiliaryCount + '\n' + (preview.auxiliaryFiles ?? []).slice(0, 10).join('\n')
      const artifactResult = value => (value.auxiliaryCount ?? 0) === 0 ? '' :
        (locale === 'en' ? ' · auxiliary files preserved: ' : ' · 附属备份已保留：') + value.auxiliaryCount + ' · ' + value.artifactDir

      const onMerge = (commit) => run(`merge-${commit.sha}`, async () => {
        const plan = await restorePaths(commit)
        if (plan === null) return
        const { preview, projectPaths } = plan
        const summary = `${t('restore.new')}: ${preview.willWriteCount ?? 0} · ${t('restore.same')}: ${preview.identical ?? 0} · ${t('restore.fork')}: ${preview.willForkCount ?? 0}`
        const ok = await ask(`${t('restore.previewTitle')}\n${summary}\n\n${t('restore.mergeHint')}${groupsSummary(groupsOf(preview), true)}${artifactPreview(preview)}`)
        if (!ok) return
        const result = await call('/restore/merge', { method: 'POST', body: { commit: commit.sha, projectPaths } })
        const merged = result.result ?? {}
        if (merged.ok === false) throw new Error(merged.error ?? 'Restore failed')
        const groups = groupsOf(merged)
        setNote({ kind: groups == null || groupsNeedAttention(groups) ? 'info' : 'ok', value: `日志安全合并完成 · 新增 ${merged.written ?? 0} · 跳过 ${merged.skipped ?? 0} · 冲突副本 ${(merged.forks ?? []).length}${artifactResult(merged)}${groupsSummary(groups)}` })
        await refresh()
        await refreshHistory()
      })

      // 全量还原保留本地增量；先确认目标设备项目目录，再进行历史前缀校验。
      const onOverwrite = (commit) => run(`overwrite-${commit.sha}`, async () => {
        const plan = await restorePaths(commit)
        if (plan === null) return
        const { projectPaths, preview } = plan
        const ok = await ask(
          `${t('restore.confirmOverwrite')}\n\n` +
          `${shortSha(commit.sha)} · ${formatTime(commit.at)}\n\n` +
          `${t('restore.overwriteHint')}\n\n` +
          `${t('restore.overwriteRisk')}${groupsSummary(groupsOf(preview), true)}${artifactPreview(preview)}`,
        )
        if (!ok) return
        const result = await call('/restore/overwrite/apply', { method: 'POST', body: { commit: commit.sha, projectPaths } })
        const value = result?.result ?? {}
        if (value.ok === false) {
          setNote({ kind: 'error', value: `${locale === 'en' ? 'Full restore failed' : '全量还原失败'}：${value.error ?? 'unknown'}` })
          return
        }
        const groups = groupsOf(value)
        setNote({
          kind: groups == null || groupsNeedAttention(groups) ? 'info' : 'ok',
          value: `日志还原完成 · 恢复 ${value.replaced ?? 0} 个文件 · 保留 ${value.preserved ?? 0} 份本地历史 · 安全快照已保留${artifactResult(value)}${groupsSummary(groups)}`,
        })
        await refresh()
        await refreshHistory()
      })

      const onDeleteHistory = (commit) => run(`delete-${commit.sha}`, async () => {
        const ok = await ask(`${t('history.deleteConfirm')}\n\n${shortSha(commit.sha)} · ${formatTime(commit.at)}`)
        if (!ok) return
        await call('/history/delete', { method: 'POST', body: { commit: commit.sha } })
        setNote({ kind: 'ok', value: t('history.deleted') })
        await refresh()
        await refreshHistory()
      })

      // 批量删除：勾选多条后一次确认，串行执行。
      // 顺序必须是「新→旧」（history 列表本身就是新→旧）：后端删除一条提交只会
      // 重算它之后的提交、保留其祖先的 SHA——从最新开始删，剩余待删项都是祖先，
      // SHA 不受影响；若按点击顺序先删旧提交，其后所有选中项的 SHA 已被重写，
      // 再删会命中「不在可见历史中」并静默中断，留下半删状态。
      // 中途失败则停止并把 UI 强制刷新回真实状态，绝不假装全部成功。
      const onDeleteSelected = () => run('delete-selected', async () => {
        const shas = history.filter(commit => selected.has(commit.sha)).map(commit => commit.sha)
        if (shas.length === 0) return
        const ok = await ask(`${t('history.deleteConfirm')}\n\n将删除 ${shas.length} 条历史，本地与远端同步重写，不可恢复。`)
        if (!ok) return
        let done = 0
        let failure = null
        for (const sha of shas) {
          try {
            await call('/history/delete', { method: 'POST', body: { commit: sha } })
            done += 1
          } catch (error) {
            failure = error
            break
          }
        }
        setSelected(new Set())
        await refresh()
        await refreshHistory()
        if (failure !== null) {
          setNote({ kind: 'error', value: `已删除 ${done} / ${shas.length} 条，第 ${done + 1} 条失败：${failure.message}` })
          return
        }
        setNote({ kind: 'ok', value: t('history.deleted') })
      })

      const onCancelPending = () => run('cancel-pending', async () => {
        await call('/restore/pending/cancel', { method: 'POST', body: { id: pending.id } })
        setNote(null)
        await refreshPending()
      })

      const busyAny = busy !== ''

      return h('div', { className: 'ss-root', 'data-dsh-session-sync-view': '' },
        h('div', { className: 'ss-head' },
          h('h2', { className: 'ss-title' }, t('page.title')),
          h('p', { className: 'ss-sub' }, t('page.subtitle')),
        ),

        h('nav', { className: 'ss-tabs', role: 'tablist' },
          TAB_DEFS.map((def) => h('button', {
            key: def.key,
            className: `ss-tab${tab === def.key ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': tab === def.key ? 'true' : 'false',
            onClick: () => setTab(def.key),
          }, def.label)),
        ),

        // 三 TAB 常驻挂载：用 display 切换显隐而非条件渲染卸载。
        // 组件不卸载 → 各 TAB 的 useEffect 不重跑 → 切 TAB 不重新拉取数据。
        h('div', { key: 'pane-session', style: { display: tab === 'session' ? 'contents' : 'none' } },
          h('div', { className: 'ss-tab-body' }, [

        // 状态
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, t('status.heading')),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => run('refresh', async () => { await refresh(); await refreshHistory(); await refreshPending() }) }, busy === 'refresh' ? t('status.loading') : t('status.refresh')),
            ),
          ),
          groupsOf(status) == null ? null : h('div', { className: `ss-note ${groupsNeedAttention(groupsOf(status)) ? 'info' : 'ok'}`, role: 'status', style: { whiteSpace: 'pre-wrap' } }, `最近启动/还原分组结果${groupsSummary(groupsOf(status))}`),
          h('div', { className: 'ss-grid' },
            h(Field, { label: t('status.remote'), value: status?.remote ?? config.remote ?? t('status.unset'), mono: true }),
            h(Field, { label: t('status.branch'), value: status?.branch ?? config.branch }),
            h(Field, { label: t('status.head'), value: shortSha(status?.head), mono: true }),
            h(Field, { label: t('status.remoteHead'), value: shortSha(status?.remoteHead), mono: true }),
            h(Field, { label: t('status.aheadBehind'), value: `${status?.ahead ?? 0} / ${status?.behind ?? 0}` }),
            h(Field, { label: t('status.dirty'), value: String((status?.dirty ?? []).length) }),
            h(Field, { label: t('status.forks'), value: String((status?.forks ?? []).length) }),
            h(Field, { label: t('status.lastBackup'), value: formatTime(schedule?.lastRunAt ?? operation?.lastResult?.at) }),
          ),
          status?.error ? h(Note, { kind: 'info', value: status.error }) : null,
          h(Note, { kind: note?.kind ?? 'info', value: note?.value }),
        ),

        // 配置
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, t('config.heading'))),
          h('p', { className: 'ss-card-hint' }, t('config.hint')),
          h('label', { className: 'ss-field' },
            h('span', { className: 'ss-label' }, 'Git 认证方式'),
            h('select', { className: 'ss-input', value: authModeDraft, onChange: event => setAuthModeDraft(event.target.value) },
              h('option', { value: 'system' }, '系统 Git 凭据管理器 / SSH Agent'),
              h('option', { value: 'ssh-key' }, '指定 SSH 私钥路径'),
            ),
          ),
          authModeDraft === 'ssh-key' ? h('label', { className: 'ss-field' },
            h('span', { className: 'ss-label' }, 'SSH 私钥路径（仅保存路径，不上传私钥）'),
            h('input', { className: 'ss-input', value: sshKeyDraft, autoComplete: 'off', placeholder: '~/.ssh/id_ed25519', onChange: event => setSshKeyDraft(event.target.value) }),
          ) : null,
          h('p', { className: 'ss-card-hint' }, 'HTTPS 地址使用系统 Git 已配置的凭据助手；SSH 地址使用 Agent 或指定密钥。需先在系统完成登录/主机指纹确认；加密私钥请先加入 SSH Agent。此认证与 Gist 授权独立。'),
          h('div', { className: 'ss-grid' },
            h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
              h('span', { className: 'ss-label' }, t('config.remote')),
              h('input', {
                className: 'ss-input', type: 'text', value: remoteDraft, spellCheck: false, autoComplete: 'off',
                placeholder: t('config.remotePlaceholder'),
                onChange: (event) => setRemoteDraft(event.target.value),
              }),
            ),
            h('div', { className: 'ss-field' },
              h('span', { className: 'ss-label' }, t('config.branch')),
              h('input', {
                className: 'ss-input', type: 'text', value: branchDraft, spellCheck: false, autoComplete: 'off',
                onChange: (event) => setBranchDraft(event.target.value),
              }),
            ),
            h('div', { className: 'ss-field' },
              h('span', { className: 'ss-label' }, '\u00a0'),
              h('div', { className: 'ss-row' },
                h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: onSave }, busy === 'save' ? t('config.saving') : t('config.save')),
                h('button', { className: 'ss-btn', disabled: busyAny, onClick: onCheck }, t('config.check')),
              ),
            ),
          ),
        ),

        // 手动备份
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, t('backup.heading')),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn', disabled: busyAny, onClick: onPreview }, t('backup.preview')),
              h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: onBackup }, busy === 'backup' ? t('backup.running') : t('backup.run')),
            ),
          ),
          h('p', { className: 'ss-card-hint' }, t('backup.hint')),
        ),

        // 自动备份
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, t('auto.heading'))),
          h('p', { className: 'ss-card-hint' }, t('auto.hint')),
          scheduleDraft === null ? null : h('div', { className: 'ss-grid' },
            h('label', { className: 'ss-toggle' },
              h('input', {
                type: 'checkbox', checked: scheduleDraft.enabled === true,
                onChange: (event) => setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked }),
              }),
              h('span', null, t('auto.enable')),
            ),
            h('div', { className: 'ss-field', style: { gridColumn: '1 / -1' } },
              h('span', { className: 'ss-label' }, `${t('auto.mode.daily')} / ${t('auto.mode.interval')}`),
              h('select', {
                className: 'ss-input', value: scheduleDraft.mode,
                onChange: (event) => setScheduleDraft({ ...scheduleDraft, mode: event.target.value }),
              },
                h('option', { value: 'daily' }, t('auto.mode.daily')),
                h('option', { value: 'interval' }, t('auto.mode.interval')),
              ),
            ),
            scheduleDraft.mode === 'interval'
              ? h('div', { className: 'ss-field' },
                  h('span', { className: 'ss-label' }, t('auto.every')),
                  h('input', {
                    className: 'ss-input', type: 'number', min: '5', max: '10080', value: String(scheduleDraft.everyMinutes ?? 60),
                    onChange: (event) => setScheduleDraft({ ...scheduleDraft, everyMinutes: event.target.value }),
                  }),
                )
              : h('div', { className: 'ss-row', style: { gridColumn: '1 / -1' } },
                  h('div', { className: 'ss-field', style: { flex: '0 0 100px' } },
                    h('span', { className: 'ss-label' }, t('auto.hour')),
                    h('input', {
                      className: 'ss-input', type: 'number', min: '0', max: '23', value: String(scheduleDraft.atHour ?? 3),
                      onChange: (event) => setScheduleDraft({ ...scheduleDraft, atHour: event.target.value }),
                    }),
                  ),
                  h('div', { className: 'ss-field', style: { flex: '0 0 100px' } },
                    h('span', { className: 'ss-label' }, t('auto.minute')),
                    h('input', {
                      className: 'ss-input', type: 'number', min: '0', max: '59', value: String(scheduleDraft.atMinute ?? 0),
                      onChange: (event) => setScheduleDraft({ ...scheduleDraft, atMinute: event.target.value }),
                    }),
                  ),
                ),
            h(Field, { label: t('auto.next'), value: schedule?.nextRunAt ? formatTime(schedule.nextRunAt) : t('status.none') }),
            h('div', { className: 'ss-field' },
              h('span', { className: 'ss-label' }, '\u00a0'),
              h('div', { className: 'ss-row' },
                h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: onSaveSchedule }, t('config.save')),
              ),
            ),
          ),
        ),

        // 待执行还原
        pending === null ? null : h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' },
            h('h3', { className: 'ss-card-title' }, t('restore.pending')),
            h('div', { className: 'ss-actions' },
              h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: onCancelPending }, t('restore.cancel')),
            ),
          ),
          h('p', { className: 'ss-card-hint' }, `${shortSha(pending.commit)} · ${formatTime(pending.createdAt)}`),
        ),

        // 历史
        h('section', { className: 'ss-card' },
          h('div', { className: 'ss-card-head' }, h('h3', { className: 'ss-card-title' }, t('history.heading'))),
          h('p', { className: 'ss-card-hint' }, t('history.hint')),
          h(HistoryMultiSelect, { total: history.length, selected, onToggleAll: toggleAll }),
          selected.size > 0 ? h('div', { className: 'ss-actions', style: { paddingBottom: '6px' } },
            h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void onDeleteSelected() }, `批量删除 (${selected.size})`),
          ) : null,
          h('div', { className: 'ss-list' },
            historyError ? h('div', { className: 'ss-note error', role: 'alert' }, `备份历史读取失败：${historyError}。请点击刷新重试；已读取的历史仍保留。`) : null,
            history.length === 0
              ? (historyError ? null : h('div', { className: 'ss-empty' }, t('history.empty')))
              : history.map((commit) => h('div', { className: `ss-item${selected.has(commit.sha) ? ' selected' : ''}`, key: commit.sha },
                  h('div', { className: 'ss-item-head' },
                    h('label', { className: 'ss-check' },
                      h('input', { type: 'checkbox', checked: selected.has(commit.sha), onChange: () => toggle(commit.sha) }),
                    ),
                    h('div', { className: 'ss-item-main' },
                      h('span', null, commit.subject || shortSha(commit.sha)),
                      h('span', { className: 'ss-item-sub' }, `${shortSha(commit.sha)} · ${formatTime(commit.at)}`),
                    ),
                  ),
                  h('span', { className: 'ss-badge' }, sourceLabel(commit.source)),
                  h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => onMerge(commit) }, t('history.merge')),
                  h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => onOverwrite(commit) }, t('history.overwrite')),
                   h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => onDeleteHistory(commit) }, t('history.delete')),
                )),
          ),
        ),
          ]),
        ),
        h('div', { key: 'pane-plugin', style: { display: tab === 'pluginbackup' ? 'contents' : 'none' } },
          h(PluginBackupTab, { cloud: CLOUD }),
        ),
        h('div', { key: 'pane-skill', style: { display: tab === 'skillbackup' ? 'contents' : 'none' } },
          h(SkillBackupTab, { cloud: CLOUD }),
        ),

        projectDialog === null ? null : h(ProjectPathDialog, { projects: projectDialog, onResolve: resolveProjectDialog }),
        confirm === null ? null : h(ConfirmDialog, { message: confirm.message, onResolve: resolveConfirm }),
      )
    }

    /** 侧栏行图标（与壳层其他面板行同尺寸同风格）。 */
    function SessionSyncPanelIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', 'data-dsh-panel-entry': PANEL_ID,
      },
        h('path', { d: 'M4.2 11.5a2.7 2.7 0 0 1 .3-5.4 3.4 3.4 0 0 1 6.5-.5 2.6 2.6 0 0 1-.4 5.9' }),
        h('path', { d: 'M8 12.5V7.6M6.2 9.3 8 7.5l1.8 1.8' }),
      )
    }

    const inject = ['slots', 'locale']

    // ---------------------------------------------------------------------
    // 备份进度浮层（右下角，跨工作区常驻）
    //
    // 挂在 `shell.overlay`（AppFrame 框架层，见 dsh-client-ui-layout），
    // 因此切工作区/切会话都不会卸载 —— 这正是"在其他工作区对话内也能实时查看"的实现依据。
    //
    // 数据全部来自后端 /progress（真 git 百分比/对象计数/速率）。
    // 后端 percent 为 null 时走"不确定态"（流动条纹 + 已用时长），绝不编造数字。
    // ---------------------------------------------------------------------
    const PROGRESS_POLL_MS = 500
    /** 完成后播放收尾动画的时长（与后端 FINISHED_LINGER_MS=6000 留出余量）。 */
    const PROGRESS_EXIT_MS = 520

    /** 阶段文案（中文/英文二选一，跟随现有 locale 机制）。 */
    function stageLabel(stage, phase) {
      const table = locale === 'en'
        ? { starting: 'Preparing…', mirror: 'Mirroring files…', collecting: 'Collecting…', push: 'Uploading…', delete: 'Deleting…' }
        : { starting: '准备中…', mirror: '镜像文件中…', collecting: '收集数据中…', push: '上传中…', delete: '删除中…' }
      if (stage === 'push' && typeof phase === 'string' && phase !== '') {
        const phases = locale === 'en'
          ? { enumerating: 'Enumerating', counting: 'Counting', compressing: 'Compressing', writing: 'Uploading', receiving: 'Receiving', resolving: 'Resolving', updating: 'Updating', transfer: 'Transferring' }
          : { enumerating: '枚举对象', counting: '计数对象', compressing: '压缩对象', writing: '上传对象', receiving: '接收对象', resolving: '解析增量', updating: '更新文件', transfer: '传输中' }
        const label = phases[phase]
        if (label !== undefined) return locale === 'en' ? `${label}…` : `${label}…`
      }
      return table[stage] ?? (locale === 'en' ? 'Working…' : '处理中…')
    }

    /** 毫秒 → 人类可读（真实耗时，不估算）。 */
    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      if (total < 60) return `${total}s`
      const m = Math.floor(total / 60)
      const s = total % 60
      return `${m}m${String(s).padStart(2, '0')}s`
    }

    /**
     * 备份进度浮层。无进度时渲染 null（不占位、不可见）。
     */
    function BackupProgressOverlay() {
      const [snapshot, setSnapshot] = useState(null)
      const [exiting, setExiting] = useState(() => new Set())
      // 平滑插值：显示值独立于后端值，每次轮询后用 requestAnimationFrame 追上去。
      const displayRef = useRef(new Map())
      const [displayTick, setDisplayTick] = useState(0)

      useEffect(() => {
        let stopped = false
        let timer = null
        const poll = async () => {
          try {
            const response = await fetch(`${API}/progress`)
            if (response.ok) {
              const body = await response.json()
              const value = body?.ok === false ? null : (body?.value ?? body)
              if (!stopped && value !== null && typeof value === 'object') setSnapshot(value)
            }
          } catch {
            // 后端不可用时静默：进度是附加信息，不该打扰用户。
          }
          if (!stopped) timer = setTimeout(poll, PROGRESS_POLL_MS)
        }
        void poll()
        return () => {
          stopped = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []

      // 条目唯一键：kind + action。同域可以同时有备份和删除两条，
      // 只用 kind 会互相误判（删除完成把备份的条目标成 exiting，反之亦然）。
      const keyOf = (entry) => `${entry.kind}:${entry.action ?? 'backup'}`

      // 新一轮开始（running）时必须清除该条目的退出标记与残留显示值：
      // 否则上一次的 is-exiting（CSS opacity:0 + scale）会永久粘住，
      // 进度条明明渲染了却完全看不见 —— 实测：第二次备份起全部不可见。
      useEffect(() => {
        const runningKeys = entries.filter((e) => e.state === 'running').map(keyOf)
        if (runningKeys.length === 0) return
        setExiting((prev) => {
          if (!runningKeys.some((k) => prev.has(k))) return prev
          const next = new Set(prev)
          for (const k of runningKeys) next.delete(k)
          return next
        })
        for (const k of runningKeys) displayRef.current.delete(k)
      }, [entries.map((e) => `${keyOf(e)}:${e.state}`).join('|')])

      // 平滑插值驱动：有进行中条目时持续刷新显示值。
      useEffect(() => {
        const running = entries.filter((e) => e.state === 'running')
        if (running.length === 0) return undefined
        let raf = null
        const step = () => {
          setDisplayTick((n) => n + 1)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
        return () => {
          if (raf !== null) cancelAnimationFrame(raf)
        }
      }, [entries.map((e) => `${keyOf(e)}:${e.state}:${e.percent ?? 'x'}`).join('|')])

      // 已完成条目：播放退出动画后移除。
      useEffect(() => {
        const finished = entries.filter((e) => e.state === 'finished' && !exiting.has(keyOf(e)))
        if (finished.length === 0) return undefined
        const ids = finished.map(keyOf)
        const timer = setTimeout(() => {
          setExiting((prev) => {
            const next = new Set(prev)
            for (const id of ids) next.add(id)
            return next
          })
        }, 900)
        return () => clearTimeout(timer)
      }, [entries.map((e) => `${keyOf(e)}:${e.state}`).join('|')])

      if (entries.length === 0) return null

      // 按 PROGRESS_KINDS 顺序（后端已排序）上下排列。
      const rows = entries.map((entry) => {
        const isFinished = entry.state === 'finished'
        const key = keyOf(entry)
        const target = typeof entry.percent === 'number' ? entry.percent : null
        const prev = displayRef.current.get(key) ?? 0
        // 平滑：向目标值靠拢（百分数越大追得越快），但不越过目标。
        let shown = prev
        if (target !== null) {
          const delta = target - prev
          shown = isFinished ? 100 : prev + delta * 0.22
          if (Math.abs(target - shown) < 0.4) shown = target
        }
        displayRef.current.set(key, shown)

        const isDelete = (entry.action ?? 'backup') === 'delete'
        const indeterminate = target === null && !isFinished
        const phaseText = stageLabel(entry.stage, entry.phase)
        const elapsed = formatElapsed(entry.elapsedMs ?? 0)
        // 真实计数优先，两个来源都来自后端实测，不是估算：
        //   counts = git 的对象进度（如 2/3）
        //   files  = cloud 域的真实对象数（profile 数 / 技能数 / 待上传分片数）
        const gitCounts = entry.counts !== null && typeof entry.counts === 'object' && Number.isFinite(entry.counts?.total)
          ? `${entry.counts.done}/${entry.counts.total}`
          : null
        const fileCounts = entry.files !== null && typeof entry.files === 'object' && Number.isFinite(entry.files?.total) && entry.files.total > 0
          ? `${entry.files.done}/${entry.files.total}`
          : null
        const counts = gitCounts ?? fileCounts
        // 有真实计数但没有百分比时，用计数比例驱动条宽（真数据，不是插值猜测）。
        const derivedPct = target === null && entry.files !== null && Number.isFinite(entry.files?.total) && entry.files.total > 0
          ? Math.round((entry.files.done / entry.files.total) * 100)
          : null
        // 完成文案按操作区分：删除说"已删除"，备份说"备份完毕"——不能都叫备份完毕。
        const doneText = isDelete
          ? (locale === 'en' ? 'Deleted' : '已删除')
          : (locale === 'en' ? 'Done' : '备份完毕')
        const failText = isDelete
          ? (locale === 'en' ? 'Delete failed' : '删除失败')
          : (locale === 'en' ? 'Failed' : '失败')
        const detail = isFinished
          ? (entry.ok === false
              ? failText
              : [doneText, elapsed, fileCounts].filter((v) => typeof v === 'string' && v !== '').join(' · '))
          : [phaseText, counts, entry.rate, elapsed].filter((v) => typeof v === 'string' && v !== '').join(' · ')
        // 条宽：有真百分比用平滑值；只有真实计数时用计数比例；都没有才走不确定态条纹。
        const effectivePct = target !== null ? shown : derivedPct
        const showIndeterminate = indeterminate && derivedPct === null

        return h('div', {
          key,
          className: `ss-prog-row${isFinished ? ' is-done' : ''}${isFinished && entry.ok === false ? ' is-error' : ''}${exiting.has(key) ? ' is-exiting' : ''}`,
        }, [
          h('div', { key: 'head', className: 'ss-prog-head' }, [
            h('span', { key: 'title', className: 'ss-prog-title' }, entry.label ?? entry.kind),
            h('span', { key: 'detail', className: 'ss-prog-detail' }, detail),
            isFinished
              ? h('span', { key: 'badge', className: 'ss-prog-badge' }, entry.ok === false ? '✕' : '✓')
              : h('span', { key: 'pct', className: 'ss-prog-pct' }, effectivePct === null ? '' : `${Math.round(effectivePct)}%`),
          ]),
          h('div', { key: 'bar', className: `ss-prog-bar${showIndeterminate ? ' is-indeterminate' : ''}` }, [
            showIndeterminate
              ? h('div', { key: 'flow', className: 'ss-prog-flow' })
              : h('div', {
                  key: 'fill',
                  className: 'ss-prog-fill',
                  style: { width: `${Math.max(0, Math.min(100, effectivePct ?? shown))}%` },
                }),
          ]),
        ])
      })

      return h('div', { className: 'ss-prog-dock', role: 'status', 'aria-live': 'polite' }, rows)
    }

    function apply(ctx) {
      ensureStyles()
      // 语言：宿主 locale 服务可用时跟随，否则用浏览器语言判断。
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, { zh, en })
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') {
            // 每次取词都读最新语言。
            locale = String(bound('entry.label') ?? '') === en['entry.label'] ? 'en' : 'zh'
          }
        } else if (typeof navigator !== 'undefined' && !String(navigator.language ?? '').toLowerCase().startsWith('zh')) {
          locale = 'en'
        }
      } catch {
        // 语言判定失败保留中文默认。
      }

      const slots = ctx.slots
      if (slots === undefined) return

      // 侧栏行：紧跟任务看板（order 20）之后、工作区区域之前。
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('entry.label'),
      }, SessionSyncPanelIcon))

      // 中心列页面：key 与面板 id 对应。
      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        children: {},
        inject: () => ({}),
      }, SessionSyncPage))

      // 备份进度浮层：挂在框架层 shell.overlay（右下角）。
      // 该 seat 由 AppFrame 渲染，切工作区/会话不卸载 —— 跨工作区可见的依据。
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: `${PANEL_ID}.progress`,
        inject: () => ({}),
      }, BackupProgressOverlay))
    }

    return { inject, apply }
  },
})
