---
name: probe-bang
description: context-gate probe fixture. Use only when the user explicitly asks to run the probe-bang skill.
---

Probe fixture for docs/PROBE.md point 3 (does `skill.prompt` see the text before or after shell expansion?).

Shell expansion result: !`echo probe-bang-expanded`

Arguments: $ARGUMENTS

Reply with one line: "probe-bang ran" followed by the shell expansion result above, exactly as you see it.
