# Purpose: deep-merge settings files given to `jq -s -f` (base, then <os>, then optional local).
# Used by: scripts/install.sh (build_settings) and scripts/doctor.sh (drift check).
# Invariants: objects merge deeply, later files win; `hooks` lists are appended per event (a plain jq `*` would let
# local.json's hooks replace base.json's), so a machine can add hooks without restating the shared ones.
reduce .[] as $f ({}; (. * ($f | del(.hooks)))
  | if $f.hooks then .hooks = reduce ($f.hooks | to_entries[]) as $e (.hooks // {}; .[$e.key] = ((.[$e.key] // []) + $e.value))
    else . end)
