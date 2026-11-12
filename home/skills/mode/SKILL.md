---
name: mode
description: "Switch this session's setup mode: normal (economy), medium (default, balanced) or high (full force)."
disable-model-invocation: true
argument-hint: normal|medium|high
---

The mode hook already recorded the switch and injected the playbook for `$ARGUMENTS`. Reply in 4 lines or fewer:
the active mode, then the switches the user still has to type (copy them from the hook text), then continue any
pending task under the new mode.
