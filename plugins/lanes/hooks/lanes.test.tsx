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

// 闸转投(默认关):开了之后,settings Stop hooks 的拦截不交给引擎画,而是以插件消息原文转给模型
test('闸转投:关时原样拦,开时改投插件消息并清掉引擎的拦截;连撞到顶交回引擎', async ($, on) => {
  const sent: string[] = []
  on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.clock(on)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('classic.Stop', async () => ({ block: '收尾闸阻断 1 项:\n  [E0] 裸因果断言' }) as never)
  on('prompt.submit', async ($, e) => { sent.push(String((e as { text: string }).text)); return { text: (e as { text: string }).text } as never })
  // 收尾 = classic.Stop,随后这一轮结束 = turn.complete(转投在这时才发出)
  const stop = async () => { const r = await ($.classic.Stop({} as never) as Promise<{ block?: string }>); await ($.turn as unknown as { complete: (e: unknown) => Promise<unknown> }).complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' }); return r }
  expect((await stop()).block).toMatch(/收尾闸阻断/)          // 默认关:原样拦
  expect(sent.length).toBe(0)
  await $.command.run({ command: 'lanes-relay' } as never)
  for (let i = 1; i <= 5; i++) {
    const r = await stop()
    expect(r.block).toBeUndefined()                             // 引擎不再画拦截
    expect(sent.length).toBe(i)
    expect(sent[i - 1]).toMatch(/^Stop hook feedback:\n收尾闸阻断/) // 模型拿到全文,开头让收尾闸认得是续轮
  }
  expect((await stop()).block).toMatch(/收尾闸阻断/)          // 第 6 次:交回引擎,让闸自己的连撞降级生效
  expect(sent.length).toBe(5)
})
