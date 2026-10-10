import { test, expect, mock } from 'claude-code/testing'

// 整棵树的文字(根 Box 的 text 是子孙文字拼起来的)
const all = async (h: { find: (q: never) => Promise<{ text?: string } | undefined> }) => (await h.find({ type: 'Box' } as never))?.text ?? ''

// 写文件进「改过的文件」道、工具计数进汇总行;两种界面上都画得出来
test('Write 记进改文件道,Bash 记工具数,上方汇总行显示', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })   // 引擎自己的画法:插件让出时画个空框
  await $.tool.call({ tool: 'Write', file_path: 'docs/a.md', content: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: '列目录' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lanes', surface, component: 'AbovePrompt', props: {} as never })
    expect(await all(band)).toMatch(/改文件 1/)
    expect(await all(band)).toMatch(/工具 2/)
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'lanes', surface, component: 'Pane', requestId: 'lanes', props: {} as never })
    expect(await all(pane)).toMatch(/docs\/a\.md/)
    expect(await all(pane)).toMatch(/列目录/)
    await pane.unmount()
  }
})

// 子代理的工具调用(带 agentId)不混进主线三道,单独进「子代理」桶
test('子代理的调用另记,不算进主线', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })   // 引擎自己的画法:插件让出时画个空框
  await $.tool.call({ tool: 'Bash', command: 'ls', description: '主线列目录' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'sub/b.md', content: 'x', agentId: 'agentXYZ123' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd', description: '子代理查目录', agentId: 'agentXYZ123' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lanes', surface, component: 'AbovePrompt', props: {} as never })
    expect(await all(band)).toMatch(/改文件 0/)
    expect(await all(band)).toMatch(/工具 1 · 子代理 1/)
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'lanes', surface, component: 'Pane', requestId: 'lanes', props: {} as never })
    expect(await all(pane)).not.toMatch(/sub\/b\.md/)
    expect(await all(pane)).toMatch(/agentXYZ.*工具 2 · 改文件 1/)
    await pane.unmount()
  }
})

// 旧版本存下的状态缺 sub 字段(0.2.0 上线即撞「l.sub[id] undefined」):重载后照常记账、照常画
test('旧形状的状态不让记账崩', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  // 未写过时冒充旧版本留下的值(没有 sub)
  on('state.get', async ($, e, next) => {
    const r = await next(e) as { value: { value?: unknown; version: number } }
    return (e as { key: string }).key === 'lanes' && r.value.version === 0
      ? { value: { value: { turn: 3, gates: [], files: [], tools: {}, lastCmd: [] }, version: 0 } } as never
      : r as never
  })
  await $.tool.call({ tool: 'Bash', command: 'pwd', description: '子代理查目录', agentId: 'agentOLD' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: '主线列目录' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lanes', surface, component: 'AbovePrompt', props: {} as never })
    expect(await all(band)).toMatch(/工具 1 · 子代理 1/)
    await band.unmount()
  }
})

// 闸转投 v2:关时原样拦;开时仍然拦,但引擎显示的拦截文本换成一行短句(保留首行与规则号),全文以 isMeta 行附给模型
test('闸转投 v2:短句留给引擎、全文附给模型、照样拦', async ($, on) => {
  mock.clock(on)
  const rows = mock.session(on)
  const FULL = '收尾闸阻断 2 项:\n  [E0] 裸因果断言\n  [E2] 没问机械判据\n'.repeat(3)
  on('classic.Stop', async () => ({ block: FULL }) as never)
  const stop = () => $.classic.Stop({} as never) as Promise<{ block?: string }>
  const r = await stop()                                         // 默认开(会话重启后也是开)
  expect(r.block).toMatch(/^收尾闸阻断 2 项: \[E0 E2\]/)          // 仍然拦;首行与规则号保留,收尾闸的轮次边界/连撞计数认得
  expect(r.block!.length).toBeLessThan(80)                       // 输出框只剩一行
  const appended = JSON.stringify(rows.appended())
  expect(appended).toMatch(/裸因果断言/)                            // 全文到了模型那边
  await $.command.run({ command: 'lanes-relay' } as never)       // 切成关:原样
  expect((await stop()).block).toBe(FULL)
})

// 转投来的插件消息在对话里只画一行;ctrl+o 全文视图照常;别的插件的消息不碰
test('转投行折成一行,全文视图与他人消息不动', async ($, on) => {
  on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e); return <Text>ENGINE</Text> })
  const row = (origin: object, isExpanded = false) => $.ui.mount({ plugin: 'lanes', surface: 'terminal', component: 'UserMessage', props: { text: 'Stop hook feedback:\n收尾闸阻断 1 项', origin, isExpanded } as never })
  const t = async (h: { find: (q: never) => Promise<{ text?: string } | undefined> }) => (await h.find({ type: 'Text' } as never))?.text ?? ''
  expect(await t(await row({ kind: 'plugin', name: 'lanes' }))).toMatch(/闸拦了一下/)
  expect(await t(await row({ kind: 'plugin', name: 'lanes' }, true))).toBe('ENGINE')
  const other = await $.ui.mount({ plugin: 'lanes', surface: 'terminal', component: 'UserMessage', props: { text: '普通的一句话', origin: { kind: 'plugin', name: 'other' }, isExpanded: false } as never })
  expect(await t(other)).toBe('ENGINE')
})

// 模型能调的开关工具:control 改 relay
test('control 工具能开关闸转投', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }) as never)
  const r = await $.tool.call({ tool: 'mcp__lanes__control', setting: 'relay', value: true } as never) as { text?: string; result?: string }
  expect(JSON.stringify(r)).toMatch(/闸转投已开/)
})

// 工具行不论是否在跑都藏(10 秒自动转后台之后,用户:「工具行还是隐蔽掉吧」)
test('工具行运行中与跑完都藏', async ($, on) => {
  on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e); return <Text>ENGINE</Text> })
  const t = async (h: { find: (q: never) => Promise<{ text?: string } | undefined> }) => (await h.find({ type: 'Text' } as never))?.text ?? ''
  const row = (isRunning: boolean) => $.ui.mount({ plugin: 'lanes', surface: 'terminal', component: 'ToolUse', props: { tool: 'Bash', input: { command: 'sleep 99' }, isRunning, isErrored: false, isInterrupted: false } as never })
  expect(await t(await row(true))).toBe('')
  expect(await t(await row(false))).toBe('')
})

// 前台 Bash/PowerShell 的 timeout 压到 10 秒(撞到即自动转后台);显式后台的、关掉开关后的不动
test('长命令 10 秒自动转后台', async ($, on) => {
  const seen: unknown[] = []
  on('tool.call', async ($, e) => { seen.push((e as { timeout?: number }).timeout); return { result: 'ok' } as never })
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'x', timeout: 600000 } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'x', timeout: 3000 } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'x', run_in_background: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'x', timeout: 600000, agentId: 'agentWAIT' } as never)   // 子代理不压
  await $.tool.call({ tool: 'mcp__lanes__control', setting: 'autoBg', value: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'x', timeout: 600000 } as never)
  expect(seen).toEqual([10000, 10000, 3000, undefined, 600000, 600000])   // control 由插件自己应答,不落到底层
})
