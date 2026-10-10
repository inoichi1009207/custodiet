export type GateNote = { at: number; text: string; blocking: boolean }
export type FileEdit = { path: string; tool: string }
export type Lanes = {
  turn: number
  gates: GateNote[]
  files: FileEdit[]
  tools: Record<string, number>
  lastCmd: string[]
  /** 子代理的动静单独记(用户 2026-10-09:「你和 subagent 的信息都会混进 lanes」):按 agentId 分桶 */
  sub: Record<string, SubLane>
}
export type SubLane = { tools: number; files: number; gates: number; last: string }

declare module 'claude-code' {
  interface PluginState {
    lanes: { lanes: Lanes; showAll: boolean; relay: boolean; relayLast: string; autoBg: boolean }
  }
}
