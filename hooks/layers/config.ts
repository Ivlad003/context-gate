// Core: .claude/gate.json loading and the lazy session bootstrap shared by every hook.
// A schema error disables layer 2 (skill-gate) and records why for /gate why; layer 1 keeps
// running on defaults (SPEC "Конфігурація", MOD-ADAPTER "session.start").


import { defaultConfig, envMaskValues, filterEnv, loadConfig, tierForModel } from '../../packages/core/src/config.ts'
import { json } from '../state.ts'
import { type Io, type Runtime, debug, initRoot, join } from '../ctx.ts'

export const GATE_JSON = '.claude/gate.json'

export async function loadGateConfig(io: Io, rt: Runtime): Promise<void> {
  const text = await io.fs.read(join(rt.root, GATE_JSON)).then((t) => (typeof t === 'string' ? t : undefined), () => undefined)
  const { config, diagnostics } = loadConfig(text)
  rt.configDiagnostics = diagnostics
  delete rt.disabled.gate
  if (config) {
    rt.config = config
    rt.cfg = config
  } else {
    rt.config = undefined
    rt.cfg = defaultConfig()
    const first = diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0]
    rt.disabled.gate = `${GATE_JSON}: ${first ? `${first.code} ${first.message}` : 'помилка конфігурації'} — skill-gate вимкнено`
    debug(io, rt.disabled.gate)
  }
  if (rt.cfg.cursorRules?.enabled === false) rt.disabled.rules = 'cursorRules.enabled: false'
  else delete rt.disabled.rules
  if (await io.fs.exists(join(rt.root, '.claude/rules/cursor')).catch(() => false)) {
    rt.disabled.rules = '.claude/rules/cursor/ існує (згенеровано context-gate sync) — шар cursor-rules вимкнено, щоб не дублювати контекст'
  }
  rt.itemsDirty = true
  rt.promptsDirty = true
  rt.whitelist = undefined
  await writeConfigStatus(io, rt)
}

export async function writeConfigStatus(io: Io, rt: Runtime): Promise<void> {
  const errors = rt.configDiagnostics.filter((d) => d.severity === 'error').length
  await io.update('config', () => json({ ok: rt.config !== undefined && errors === 0, disabled: { ...rt.disabled }, diagnostics: rt.configDiagnostics.length }))
}

/** Lazily bootstrap the session (session.start does it eagerly; a hot reload or a test may skip it). */
export async function ensureSession(io: Io, rt: Runtime): Promise<void> {
  if (rt.ready) return
  rt.ready = true
  try {
    await initRoot(io, rt)
    await loadGateConfig(io, rt)
    const model = await io.session.model().catch(() => undefined)
    if (model) {
      const cw = await io.session.usage().then((u) => u.context.window, () => undefined)
      await io.update('model', () => model)
      await io.update('tier', () => modelTier(rt, model, cw))
    }
    if (rt.options.profile) {
      await io.update('manual', (m) => (m.profile !== undefined || m.off ? m : json({ ...m, profile: rt.options.profile })))
    }
  } catch (err) {
    rt.ready = false
    debug(io, `bootstrap failed: ${String((err as Error)?.message ?? err)}`)
    if (!rt.cfg) rt.cfg = defaultConfig()
  }
}

/** Tier for a model (G-01): `models` globs and attribute entries, then the harness's context window
 * (`$.session.usage().context.window`, main loop only) through `tiers[*].thresholds`. */
export function modelTier(rt: Runtime, model: string, contextWindow?: number): string {
  return tierForModel(rt.cfg ?? defaultConfig(), model, contextWindow ? { contextWindow } : undefined).tier
}

// ───────────────────────── env whitelist (G-03) ─────────────────────────
// PROBE #9: `$.env.get` takes literal names only, so the gate.json `env` whitelist reads the settings `env`
// block (`$.settings.read()`) instead. Only whitelisted names reach the DSL (`env.*`); their values are masked
// in debug output (`envMask`).

const envCache = new WeakMap<Runtime, { cfg: unknown; env: Record<string, string> }>()

export async function ensureEnv(io: Io, rt: Runtime): Promise<Record<string, string>> {
  const list = rt.cfg?.env
  if (!list?.length) return {}
  const hit = envCache.get(rt)
  if (hit && hit.cfg === rt.cfg) return hit.env
  let source: Record<string, unknown> | undefined
  try {
    const s = await io.settings?.read()
    const e = s?.env
    source = e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : undefined
  } catch (err) {
    debug(io, `settings.read: ${String((err as Error)?.message ?? err)}`)
  }
  const env = filterEnv(source, list)
  envCache.set(rt, { cfg: rt.cfg, env })
  return env
}

/** Values to mask in debug output (trace, `$.ui.log`, `.claude/gate.debug.log`); empty before `ensureEnv`. */
export function envMask(rt: Runtime): string[] {
  const hit = envCache.get(rt)
  return hit && hit.cfg === rt.cfg ? envMaskValues(hit.env) : []
}
