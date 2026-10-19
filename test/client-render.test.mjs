// test/client-render.test.mjs — 真实执行 client.js 并验证关键可见元素生成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const clientUrl = new URL('../client.js', import.meta.url)

async function loadMainComponent(options = {}) {
  /** @type {any} */
let descriptor
  const document = {
    head: { append() {} },
    querySelector() { return null },
    createElement(tag) { return { tagName: tag.toUpperCase(), dataset: {}, showModal() {} } },
  }
  const window = {
    __ModuleLoader__: { load(value) { descriptor = value } },
    confirm() { return false },
    open() {},
  }
  const source = await fs.readFile(clientUrl, 'utf8')
  vm.runInNewContext(source, { window, document, navigator: { language: 'zh-CN' }, fetch: options.fetch ?? (async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) })), setTimeout: options.setTimeout, clearTimeout: options.clearTimeout })

  let hookIndex = 0
  let overrides = {}
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = hookIndex++
      const value = Object.hasOwn(overrides, index)
        ? overrides[index]
        : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useCallback(fn) { return fn },
    useEffect(fn) { options.effects?.push(fn) },
    useRef(value) { return { current: value } },
  }
  const plugin = descriptor.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module: ${name}`)
  })
  let Main
  const slots = {
    inject(_name, install) { install() },
    register(meta, component) {
      if (meta.name === 'main') Main = component
      return null
    },
  }
  plugin.apply({ slots })
  assert.equal(typeof Main, 'function')

  function renderNode(node, componentOverrides) {
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (Array.isArray(node)) return node.flatMap(item => renderNode(item, componentOverrides))
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') {
      const previousIndex = hookIndex
      const previousOverrides = overrides
      hookIndex = 0
      overrides = componentOverrides[node.type.name] ?? {}
      const rendered = node.type(node.props ?? {})
      hookIndex = previousIndex
      overrides = previousOverrides
      return renderNode(rendered, componentOverrides)
    }
    return [{ ...node, renderedChildren: renderNode(node.props?.children, componentOverrides) }]
  }

  return (componentOverrides) => {
    hookIndex = 0
    overrides = componentOverrides.Main ?? {}
    return renderNode({ type: Main, props: {} }, componentOverrides)
  }
}

function textOf(node) {
  return (node.renderedChildren ?? []).map(child => typeof child === 'object' ? textOf(child) : String(child)).join('')
}

test('会话历史自动轮询获取远端，等待完成后重排，并在卸载时取消', async () => {
  const effects = []
  const timers = new Map()
  let nextTimer = 0
  let requests = 0
  let release
  const render = await loadMainComponent({
    effects,
    setTimeout(fn, delay) { assert.equal(delay, 60_000); timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout(id) { timers.delete(id) },
    fetch: async () => {
      requests++
      await new Promise(resolve => { release = resolve })
      return { ok: true, json: async () => ({ ok: true, value: { history: { ok: true, commits: [] } } }) }
    },
  })
  render({})
  const poll = effects.find(fn => fn.toString().includes('let stopped = false'))
  assert.equal(typeof poll, 'function')
  const dispose = poll()
  const tick = timers.values().next().value
  timers.clear()
  const pending = tick()
  assert.equal(requests, 1)
  assert.equal(timers.size, 0, 'no overlapping fetch while remote request is pending')
  release()
  await pending
  assert.equal(timers.size, 1)
  dispose()
  assert.equal(timers.size, 0)
})

function collect(nodes, predicate) {
  const out = []
  const visit = (node) => {
    if (typeof node !== 'object' || node === null) return
    if (predicate(node)) out.push(node)
    for (const child of node.renderedChildren ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

function deleteButtons(nodes) {
  return collect(nodes, node => node.type === 'button' && textOf(node) === '删除' && String(node.props?.className ?? '').includes('danger'))
}

function activeTabLabel(nodes) {
  const tabs = collect(nodes, node => node.type === 'button' && node.props?.role === 'tab' && node.props?.['aria-selected'] === 'true')
  return tabs.length === 1 ? textOf(tabs[0]) : null
}

/** 当前激活 TAB 的 pane 子树：三 TAB 常驻挂载，只有激活 pane 的 display 是 'contents'。 */
function activePane(nodes) {
  const panes = collect(nodes, node => typeof node.props?.key === 'string' && node.props.key.startsWith('pane-'))
  const active = panes.filter(node => node.props?.style?.display !== 'none')
  return active.length === 1 ? active[0] : null
}

test('会话备份历史实际渲染 danger 删除按钮', async () => {
  const render = await loadMainComponent()
  const nodes = render({
    SessionSyncPage: {
      4: [{ sha: '1111111111111111111111111111111111111111', at: Date.now(), author: 'Alice', subject: 'manual', source: 'manual' }],
    },
  })
  const buttons = deleteButtons(nodes)
  assert.equal(buttons.length, 1)
  assert.equal(typeof buttons[0].props.onClick, 'function')
  // 多选门：只统计激活 pane 内的 checkbox（三 TAB 常驻，其他 pane 是隐藏的）。
  const pane = activePane(nodes)
  assert.ok(pane !== null, '应有且只有一个激活 pane')
  const boxes = collect([pane], node => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(boxes.length, 2, `激活 pane 应有 2 个 checkbox，实际 ${boxes.length}`)
})

test('插件备份历史实际渲染 danger 删除按钮', async () => {
  const render = await loadMainComponent()
  const nodes = render({
    SessionSyncPage: { 13: 'pluginbackup' },
    PluginBackupTab: {
      4: [{ key: 'snapshots/history/one.zip', deviceName: 'desktop', createdAt: Date.now(), changes: [] }],
      // PluginBackupTab 的 hook 顺序：…confirm(9) selected(10)。批量按钮按 selected.size > 0 渲染。
      10: new Set(['snapshots/history/one.zip']),
    },
  })
  const buttons = deleteButtons(nodes)
  assert.equal(buttons.length, 1)
  assert.equal(typeof buttons[0].props.onClick, 'function')
  // 多选门：只统计激活 pane 内的 checkbox 与批量按钮（三 TAB 常驻挂载）。
  const pane = activePane(nodes)
  assert.ok(pane !== null, '应有且只有一个激活 pane')
  const boxes = collect([pane], node => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(boxes.length, 2, `激活 pane 应有 2 个 checkbox，实际 ${boxes.length}`)
  const batch = collect([pane], node => node.type === 'button' && textOf(node).startsWith('批量删除'))
  assert.equal(batch.length, 1, `应有批量删除按钮，实际 ${batch.length}`)
})

test('技能备份页签存在且渲染 danger 删除按钮（含还原按钮）', async () => {
  const render = await loadMainComponent()
  const nodes = render({
    SessionSyncPage: { 13: 'skillbackup' },
    SkillBackupTab: {
      // SkillBackupTab 的 hook 顺序：local(0) history(1) provider(2) result(3) error(4) busy(5) confirm(6) selected(7)。
      1: [{ key: 'skills/dws-abc.json.gz', name: 'dws', sha256: 'a'.repeat(64), sourceBytes: 2357324, deviceName: 'desktop', createdAt: new Date().toISOString() }],
      // selected 必须注入非空集合，否则批量按钮按 selected.size > 0 不渲染。
      7: new Set(['skills/dws-abc.json.gz']),
    },
  })
  assert.equal(activeTabLabel(nodes), '技能备份')
  const buttons = deleteButtons(nodes)
  assert.equal(buttons.length, 1)
  assert.equal(typeof buttons[0].props.onClick, 'function')
  const restore = collect(nodes, node => node.type === 'button' && textOf(node) === '还原' && String(node.props?.className ?? '').includes('ss-btn'))
  assert.equal(restore.length, 1)
  assert.equal(typeof restore[0].props.onClick, 'function')
  // 多选门：只统计激活 pane 内的 checkbox 与批量按钮。
  const pane = activePane(nodes)
  assert.ok(pane !== null, '应有且只有一个激活 pane')
  const boxes = collect([pane], node => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(boxes.length, 2, `激活 pane 应有 2 个 checkbox，实际 ${boxes.length}`)
  const batch = collect([pane], node => node.type === 'button' && textOf(node).startsWith('批量'))
  assert.equal(batch.length, 2, `应有批量还原 + 批量删除两个按钮，实际 ${batch.length}`)
  // 常驻挂载门：三个 pane 都必须在渲染树里（切 TAB 不卸载）。
  const panes = collect(nodes, node => typeof node.props?.key === 'string' && node.props.key.startsWith('pane-'))
  assert.deepEqual(panes.map(node => node.props.key).sort(), ['pane-plugin', 'pane-session', 'pane-skill'])
})

test('认证配置显示系统凭据和SSH密钥选项', async () => {
  const render = await loadMainComponent()
  const nodes = render({})
  const options = collect(nodes, node => node.type === 'option').map(textOf)
  assert.ok(options.includes('系统 Git 凭据管理器 / SSH Agent'))
  assert.ok(options.includes('指定 SSH 私钥路径'))
})

test('顶层页签包含会话/插件/技能三个备份入口', async () => {
  const render = await loadMainComponent()
  const nodes = render({})
  const tabs = collect(nodes, node => node.type === 'button' && node.props?.role === 'tab').map(textOf)
  assert.deepEqual(tabs, ['会话备份', '插件备份', '技能备份'])
})

test('插件备份 TAB 渲染出「回收孤儿对象」按钮且 onClick 可用', async () => {
  const render = await loadMainComponent()
  const nodes = render({ SessionSyncPage: { 13: 'pluginbackup' } })
  const pane = activePane(nodes)
  assert.ok(pane !== null, '应有且只有一个激活 pane')
  const button = collect([pane], node => node.type === 'button' && textOf(node) === '回收孤儿对象')
  assert.equal(button.length, 1, '插件备份 TAB 的「其他」卡片应有回收孤儿对象按钮')
  assert.equal(typeof button[0].props.onClick, 'function')
})
