// context-gate-probe's contract: the one session-state value the probe keeps in `$.state`.
// Self-contained (no import, no reference), as the mods API requires of a plugin's `types` file.

/** `<event>[:<source>]@<iso>`, or '' before the first write. */
export type ProbeMarker = string

declare module 'claude-code' {
  interface PluginState {
    'context-gate-probe': {
      /** Written on session.start / classic.SessionStart (`<event>:<source>@<iso>`); read back after /clear. */
      marker: ProbeMarker
    }
  }
}

