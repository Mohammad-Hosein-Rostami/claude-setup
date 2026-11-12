---
name: mode
description: "Switch this session's setup mode: normal (thrift), medium (default, balanced), high (full speed), extra-high (lead Opus 5.5 at max) or ultra-high (lead Fable 5.2 at max)."
disable-model-invocation: true
argument-hint: normal|medium|high|extra-high|ultra-high
---

The mode hook recorded `$ARGUMENTS` for this session and injected the playbook. Reply in 2 lines or fewer: the
active mode, and that it applies to this session only. If the mode is high, extra-high or ultra-high, this command is
the user's request for Workflow orchestration without a size limit for the rest of this session. If the hook text
contains a lead note (a `ccm <mode> -c` line), relay it to the user in one extra line. Then continue any pending task.
