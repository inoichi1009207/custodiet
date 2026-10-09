import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Lanes, SubLane } from '../types'

// 分道(用户 2026-10-09):「你的输出、闸、改文件、工具调用四种事情混在一个输出,我会看漏」。
// 对话里只留「我说的话」;闸提示、改过的文件、工具调用各进一道,本轮一换就清零重记。
const PANE = 'lanes'
const empty: Lanes = { turn: 0, gates: [], files: [], tools: {}, lastCmd: [], sub: {} }
// $.state 跨重载保留:旧版本存下的值缺新字段(0.2.0 实撞 l.sub 为 undefined),读写前一律补齐
const norm = (l: Partial<Lanes> | undefined): Lanes => ({ ...empty, ...l, sub: l?.sub ?? {} })
const emptySub: SubLane = { tools: 0, files: 0, gates: 0, last: '' }
// 子代理的事件带 agentId(主线上缺省):只进它自己的桶,不混进主线三道
const bumpSub = (l: Lanes, id: string, f: (s: SubLane) => SubLane): Lanes => ({ ...l, sub: { ...l.sub, [id]: f(l.sub[id] ?? emptySub) } })
const lanes = atom({ plugin: 'lanes', key: 'lanes' } as const, empty)
const showAll = atom({ plugin: 'lanes', key: 'showAll' } as const, false)
// 闸转投(用户 2026-10-09:「我只需要知道你被闸拦了,细节去 lanes 看,而非在输出框里看」)。
// settings 里的 Stop hooks(收尾闸、判官)照常跑;它们的拦截与提示不交给引擎画成「Stop hook feedback」长段,
// 改由本插件以插件消息原文转给模型——那一行是 UserMessage,本插件能把它画成一行灰字,全文进 /lanes 面板。
// 默认关:收尾闸靠「Stop hook feedback:」开头认续轮(hook-stop-closure.mjs lastTurn)、靠 system 行的 hookErrors 数连撞,
// 转投后这两处要先认得插件消息才安全。RELAY_CAP:连续转投到这一轮就不再转、交回引擎原样处理,让闸自己的连撞降级生效。
const relay = atom({ plugin: 'lanes', key: 'relay' } as const, false)
const relayRun = atom({ plugin: 'lanes', key: 'relayRun' } as const, 0)
const RELAY_CAP = 5
// 引擎规矩(host check):classic.Stop 里不能 prompt.submit——会等本 hook 正把持着的那一轮。先暂存,turn.complete 再发。
const relayPending = atom({ plugin: 'lanes', key: 'relayPending' } as const, '')
const RELAY_HEAD = 'Stop hook feedback:\n'

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
  return ''
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lanes', description: '开/关分道面板:本轮闸提示 / 改过的文件 / 工具调用' })
    await $.command.register({ name: 'lanes-show', description: '切换:对话框里显示或隐藏工具调用与闸反馈' })
    await $.command.register({ name: 'lanes-relay', description: '切换:闸的拦截与提示改由插件转给模型,输出框只留一行(实验,默认关)' })
    // 开场自动打开面板(用户 2026-10-09:「下次对话一开始自动给我看 lanes」)。
    // 引擎规矩:不是人点开的面板,终端宽 ≥144 列才落座,窄了就等着——那时敲 /lanes 照样能开。
    try { await $.ui.open({ id: PANE, title: '分道' }) } catch { /* 开不了不挡会话启动 */ }
    return next(e)
  })

  // /lanes 开关两用(用户 2026-10-09:「lanes 只能开不能关」):开着就关,关着就开。
  on('command.run', { command: 'lanes' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '分道面板已关闭(再敲 /lanes 重开)。' }
    }
    await $.ui.open({ id: PANE, title: '分道' })
    return { text: '分道面板已打开(再敲 /lanes 关闭)。' }
  })

  // 用户发新消息 = 新的一轮:清空上一轮的三道
  on('prompt.submit', async ($, e, next) => {
    // 本插件转投的闸消息也走 prompt.submit:那不是新的一轮,不清账
    if ((e.origin as { kind?: string } | undefined)?.kind === 'plugin') return next(e)
    try {
      await update($, lanes, l => ({ ...empty, turn: norm(l).turn + 1 }))
      await update($, relayRun, () => 0)
    } catch { /* 记账失败不挡用户发消息 */ }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(await read($, relay))) return r
      const parts = [...(r.block ? [r.block] : []), ...(r.additionalContext ?? [])]
      if (!parts.length) { await update($, relayRun, () => 0); return r }
      const run = (await read($, relayRun)) + 1
      if (run > RELAY_CAP) return r   // 连撞到顶:交回引擎原样画、原样计数
      const text = RELAY_HEAD + parts.join('\n\n')
      const at = await $.clock.now()
      await update($, lanes, l0 => (l => ({ ...l, gates: [...l.gates, { at, text: text.slice(0, 600), blocking: !!r.block }].slice(-20) }))(norm(l0)))
      await update($, relayRun, () => run)
      await update($, relayPending, () => text)
      return { ...r, block: undefined, additionalContext: undefined }
    } catch { return r }   // 转投任何一步失败:原样交回引擎,闸照常生效
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out   // 子代理的一轮结束不发:转投只给主线
    try {
      const text = await read($, relayPending)
      if (text) {
        await update($, relayPending, () => '')
        await $.prompt.submit({ text })
      }
    } catch { /* 发不出:闸这一轮就漏了,下一次 Stop 会重新判 */ }
    return out
  })

  on('command.run', { command: 'lanes-relay' }, async $ => {
    const now = !(await read($, relay))
    await update($, relay, () => now)
    return { text: now ? '闸转投已开:拦截与提示改由插件转给模型,输出框只留一行。' : '闸转投已关:闸的反馈恢复由引擎直接显示。' }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    try { await update($, lanes, l0 => {
      const l = norm(l0)
      if (e.agentId) {
        const last = String(input.description ?? input.file_path ?? e.tool).slice(0, 60)
        return bumpSub(l, e.agentId, s => ({ ...s, tools: s.tools + 1, files: s.files + (WRITE_TOOLS.has(e.tool) ? 1 : 0), last: `${e.tool} ${last}` }))
      }
      const tools = { ...l.tools, [e.tool]: (l.tools[e.tool] ?? 0) + 1 }
      const files = WRITE_TOOLS.has(e.tool) && typeof input.file_path === 'string'
        ? [...l.files.filter(f => f.path !== input.file_path), { path: String(input.file_path), tool: e.tool }].slice(-40)
        : l.files
      const cmd = e.tool === 'Bash' || e.tool === 'PowerShell' ? String(input.description ?? input.command ?? '').slice(0, 80) : ''
      return { ...l, tools, files, lastCmd: cmd ? [...l.lastCmd, cmd].slice(-12) : l.lastCmd }
    }) } catch (err) { $.ui.status(`lanes 记账失败:${String(err).slice(0, 80)}`); /* 记账失败不挡工具调用 */ }
    return next(e)
  })

  // 闸的提示与阻断:设置里的 hook 把反馈作为 hook-context 行写进会话
  on('session.append', async ($, e, next) => {
    if (e.door === 'hook-context') try {
      const text = textOf((e.message as { content?: unknown }).content).trim()
      if (text) {
        const at = await $.clock.now()
        const blocking = /阻断|blocking error/i.test(text)
        await update($, lanes, l0 => (l => e.agentId
          ? bumpSub(l, e.agentId, s => ({ ...s, gates: s.gates + 1 }))
          : ({ ...l, gates: [...l.gates, { at, text: text.slice(0, 600), blocking }].slice(-20) }))(norm(l0)))
      }
    } catch { /* 记账失败不挡写会话行 */ }
    return next(e)
  })

  // 主对话框只留「我真正想跟你说的话」(用户 2026-10-09):工具调用行、工具结果、闸的反馈一律不在对话里画,
  // 改进右侧 /lanes 面板。/lanes-show 切换回显示(排查时用)。
  const isGateText = (t: string) => /^(Stop hook feedback|Stop hook blocking error|收尾闸阻断|收尾闭环闸命中|\[只查一件事)/.test(t.trim())
  for (const component of ['ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      if (await read($, showAll)) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }
  for (const component of ['UserMessage', 'InfoNotice', 'CommandOutput'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      const props = e.props as { text?: unknown; output?: unknown; content?: unknown }
      const text = String(props.text ?? props.output ?? props.content ?? '')
      if (!isGateText(text)) return next(e)
      try {
        const at = await $.clock.now()
        const blocking = /阻断|blocking error/i.test(text)
        await update($, lanes, l0 => (l => l.gates.some(g => g.text === text.slice(0, 600)) ? l : ({ ...l, gates: [...l.gates, { at, text: text.slice(0, 600), blocking }].slice(-20) }))(norm(l0)))
      } catch { /* 记账失败不影响画 */ }
      if (await read($, showAll)) return next(e)
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{/阻断|blocking error/i.test(text) ? '· 闸拦了一下(详见 /lanes)' : '· 闸有提示(详见 /lanes)'}</Text>
    })
  }

  on('command.run', { command: 'lanes-show' }, async $ => {
    const now = !(await read($, showAll))
    await update($, showAll, () => now)
    // 用户 2026-10-09:「不打开 lanes 的话 lanes-show 用不了」。切换后让本插件画过的对话行全部重画,
    // 不靠「哪个读者订阅了开关」去带动(面板没开时可能没有读者被带动)。
    $.ui.invalidate('ui.render')
    return { text: now ? '对话框恢复显示工具调用与闸反馈。' : '对话框只显示正文,工具与闸进 /lanes。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = norm(await read($, lanes))
    const nTools = Object.values(l.tools).reduce((a, b) => a + b, 0)
    if (e.props.hasSurvey || (l.gates.length === 0 && l.files.length === 0 && nTools === 0 && Object.keys(l.sub).length === 0)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const blocks = l.gates.filter(g => g.blocking).length
    return (
      <Box>
        <Text color={blocks ? 'red' : l.gates.length ? 'yellow' : 'gray'}>{`闸 ${l.gates.length}${blocks ? `(阻断 ${blocks})` : ''}`}</Text>
        <Text color={l.files.length ? 'cyan' : 'gray'}>{` · 改文件 ${l.files.length}`}</Text>
        <Text dimColor>{` · 工具 ${nTools}${Object.keys(l.sub).length ? ` · 子代理 ${Object.keys(l.sub).length}` : ''} · /lanes 看明细`}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = norm(await read($, lanes))
    const toolLine = Object.entries(l.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ')
    return (
      <Box flexDirection="column">
        <Text bold>第 {l.turn} 轮</Text>
        <Text bold color="red">■ 闸({l.gates.length})</Text>
        {l.gates.length === 0 && <Text dimColor>  本轮无闸提示</Text>}
        {l.gates.slice(-6).map(g => <Text color={g.blocking ? 'red' : 'yellow'}>  {g.blocking ? '[阻断] ' : '[提示] '}{g.text.split('\n').slice(0, 3).join(' / ').slice(0, 220)}</Text>)}
        <Text bold color="cyan">■ 改过的文件({l.files.length})</Text>
        {l.files.length === 0 && <Text dimColor>  本轮没改文件</Text>}
        {l.files.slice(-15).map(f => <Text>  {f.tool}  {f.path}</Text>)}
        <Text bold>■ 工具调用</Text>
        <Text dimColor>  {toolLine || '本轮无'}</Text>
        {l.lastCmd.slice(-6).map(c => <Text dimColor>  $ {c}</Text>)}
        <Text bold color="magenta">■ 子代理(另记,不算进上面三道)</Text>
        {Object.keys(l.sub).length === 0 && <Text dimColor>  本轮无</Text>}
        {Object.entries(l.sub).slice(-8).map(([id, s]) => <Text dimColor>  {id.slice(0, 8)}  工具 {s.tools} · 改文件 {s.files} · 闸 {s.gates} · 最近 {s.last}</Text>)}
      </Box>
    )
  })
}
