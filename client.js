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
      'history.overwrite': '完整覆盖',
      'history.delete': '删除',
      'history.deleteConfirm': '确认删除这条备份历史吗？本地分支和 GitHub 远端将同步重写，操作不可恢复。当前会话数据不会回滚，后续备份仍会按当前状态生成。',
      'history.deleted': '备份历史已从本地与远端删除',
      'restore.previewTitle': '还原预览',
      'restore.new': '将新增',
      'restore.same': '已相同',
      'restore.fork': '将留存冲突副本',
      'restore.mergeHint': '安全合并：只补齐本地缺失的会话；同名文件保留本地版本，备份版本另存为冲突副本。',
      'restore.overwriteHint': '完整覆盖：把会话库还原成该时间点。会先创建安全快照，需要重启 DSH 执行。',
      'restore.confirmOverwrite': '确认要把整个本机会话库替换为该备份吗？执行前会先创建安全快照。',
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
      'history.overwrite': 'Full overwrite',
      'history.delete': 'Delete',
      'history.deleteConfirm': 'Delete this backup-history entry? The local branch and GitHub remote will be rewritten together. This cannot be undone. Current session data is not rolled back and future backups still use its current state.',
      'history.deleted': 'Backup history deleted locally and remotely',
      'restore.previewTitle': 'Restore preview',
      'restore.new': 'To add',
      'restore.same': 'Already identical',
      'restore.fork': 'Conflict copies kept',
      'restore.mergeHint': 'Safe merge: fills in sessions missing locally; same-name files keep the local version and the backup version is preserved as a conflict copy.',
      'restore.overwriteHint': 'Full overwrite: restores the store to that point in time. A safety snapshot is created first and a DSH restart is required.',
      'restore.confirmOverwrite': 'Replace the entire local session store with this backup? A safety snapshot is taken first.',
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
      return h('div', { className: `ss-note ${props.kind}` }, props.value)
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
      return h('dialog', { className: 'ss-dialog', ref },
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
          else if (Array.isArray(val)) rows.push({ label, text: `${val.length} 项` })
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
        return payload.value ?? {}
      }

      async function refresh() {
        setBusy('refresh'); setError(null)
        try {
          const [inv, prov, sched, hist] = await Promise.all([
            callCloud('/inventory'), callCloud('/settings/get'),
            callCloud('/plugin-schedule/get'), callCloud('/snapshot/history'),
          ])
          setStatus(inv); setProvider(prov); setSchedule(sched); setScheduleDraft(sched); setHistory(hist)
          setForm((f) => ({ ...f, deviceName: prov?.deviceName ?? f.deviceName }))
        } catch (e) { setError(e.message) } finally { setBusy('') }
        try { setAuth(await callCloud('/github/device/status')) } catch { /* 授权状态暂不可读，忽略 */ }
      }

      useEffect(() => { void refresh() }, [])

      async function run(label, path, body) {
        setBusy(label); setError(null)
        try {
          const res = await callCloud(path, body)
          if (res && typeof res === 'object' && typeof res.verificationUri === 'string' && res.verificationUri !== '') {
            try { window.open(res.verificationUri, '_blank', 'noopener') } catch { /* 弹窗被拦时用提示框按钮 */ }
          }
          setResult(res)
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
      // 立即备份：smart 策略遇本地/远端配置冲突时后端返回 needs-choice 且【不上传】，
      // 必须显式二次推送带 resolveConflicts，否则按钮点了没有任何备份发生（实测复现）。
      const pluginBackupNow = async () => {
        setBusy('backup'); setError(null)
        try {
          let res = await callCloud('/snapshot/push')
          if (res && res.direction === 'needs-choice') {
            const conflicts = Array.isArray(res.conflicts) ? res.conflicts : []
            const list = conflicts.slice(0, 5).map((c) => `· ${c.profile ?? ''}/${c.key ?? ''}`).join('\n')
            const keepLocal = await ask(`本机与远端插件配置有 ${conflicts.length} 处不一致：\n${list}${conflicts.length > 5 ? '\n…' : ''}\n\n确定＝以本机当前配置为准完成备份；\n取消＝以远端内容为准完成备份。\n两者都会写入一份新的备份历史。`)
            res = await callCloud('/snapshot/push', { resolveConflicts: keepLocal ? 'local' : 'cloud' })
          }
          setResult(res)
        } catch (e) { setError(e.message) } finally { setBusy('') }
        void refresh()
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
            h(Field, { label: '远端可用', value: remoteAvailable ? '是' : '否' }),
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
            h(Field, { label: '加密', value: provider?.encrypted === true ? '已加密' : '未加密' }),
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
                  btn('从远端拉取快照', 'pull', '/snapshot/pull', { apply: true }),
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
              h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: () => void pluginBackupNow() }, busy === 'backup' ? '备份中…' : '立即备份'),
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
            h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteSelected() }, `批量删除 (${selected.size})`),
          ) : null,
          h('div', { className: 'ss-list' },
            !history || (Array.isArray(history) ? history.length === 0 : true)
              ? h('div', { className: 'ss-empty' }, '暂无备份历史')
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
                    h('button', { className: 'ss-btn', disabled: busyAny, onClick: () => void run('pull', '/snapshot/pull', { apply: true, snapshotKey: item.key }) }, '还原'),
                    h('button', { className: 'ss-btn danger', disabled: busyAny, onClick: () => void deleteHistoryEntry(item) }, busy === `del-${item.key}` ? '删除中…' : '删除'),
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
        return payload.value ?? {}
      }

      async function refresh() {
        setBusy('refresh'); setError(null)
        try {
          const [skills, hist, prov] = await Promise.all([
            callCloud('/skill/local-list'), callCloud('/skill/history'), callCloud('/settings/get'),
          ])
          setLocal(skills); setHistory(hist); setProvider(prov)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }

      useEffect(() => { void refresh() }, [])

      async function run(label, path, body) {
        setBusy(label); setError(null)
        try {
          const res = await callCloud(path, body)
          setResult(res)
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
              h('button', { className: 'ss-btn primary', disabled: busyAny, onClick: () => void run('backup', '/skill/push') }, busy === 'backup' ? '备份中…' : '立即备份'),
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
        const value = await call('/history?limit=50')
        setHistory(value.history?.commits ?? [])
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
            setScheduleDraft(value.schedule ?? null)
          } catch (error) {
            if (alive) setNote({ kind: 'error', value: error.message })
          }
          try {
            await refreshHistory()
          } catch (error) {
            if (alive) setHistory([])
          }
          await refreshPending()
        })()
        return () => {
          alive = false
        }
      }, [refresh, refreshHistory, refreshPending])

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
        const value = await call('/settings', { method: 'POST', body: { remote: remoteDraft, branch: branchDraft } })
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

      const onMerge = (commit) => run(`merge-${commit.sha}`, async () => {
        const value = await call('/restore/preview', { method: 'POST', body: { commit: commit.sha } })
        const preview = value.preview ?? {}
        const summary = `${t('restore.new')}: ${preview.willWriteCount ?? 0} · ${t('restore.same')}: ${preview.identical ?? 0} · ${t('restore.fork')}: ${preview.willForkCount ?? 0}`
        const ok = await ask(`${t('restore.previewTitle')}\n${summary}\n\n${t('restore.mergeHint')}`)
        if (!ok) return
        const result = await call('/restore/merge', { method: 'POST', body: { commit: commit.sha } })
        const merged = result.result ?? {}
        setNote({ kind: 'ok', value: `${t('history.merge')} ✓ ${merged.written ?? 0} / ${merged.skipped ?? 0} / ${(merged.forks ?? []).length}` })
        await refresh()
        await refreshHistory()
      })

      const onOverwrite = (commit) => run(`overwrite-${commit.sha}`, async () => {
        const ok = await ask(`${t('restore.confirmOverwrite')}\n\n${shortSha(commit.sha)} · ${formatTime(commit.at)}\n${t('restore.overwriteHint')}`)
        if (!ok) return
        await call('/restore/overwrite/prepare', { method: 'POST', body: { commit: commit.sha } })
        setNote({ kind: 'ok', value: t('restore.prepared') })
        await refresh()
        await refreshPending()
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
            history.length === 0
              ? h('div', { className: 'ss-empty' }, t('history.empty'))
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
    }

    return { inject, apply }
  },
})
