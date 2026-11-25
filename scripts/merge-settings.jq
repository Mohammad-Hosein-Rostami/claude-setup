# Purpose: deep-merge settings files given to `jq -s -f` (base, then <os>, then optional local).
# Used by: scripts/install/settings.mjs (mergedSettings).
# Invariants: objects merge deeply, later files win; `hooks` lists are appended per event (a plain jq `*` would let
# local.json's hooks replace base.json's), and permissions.allow/deny/ask/additionalDirectories are de-duplicated unions in file order
# (so a machine can add rules without restating the shared ones). A null or non-object `permissions` in a later file is
# ignored (treated as {}), so it cannot wipe the shared rules. Other arrays replace. `claudeSetup` (settings/local.json: the
# installer's and the sync's own machine values) is dropped: it is not a Claude Code setting.
def dedupe: reduce .[] as $x ([]; if index([$x]) then . else . + [$x] end);
reduce .[] as $raw ({};
  ($raw | if (.permissions | type) != "object" then del(.permissions) else . end) as $f |
  (. * ($f | del(.hooks) | if .permissions then .permissions |= del(.allow, .deny, .ask, .additionalDirectories) else . end))
  | if $f.hooks then .hooks = reduce ($f.hooks | to_entries[]) as $e (.hooks // {}; .[$e.key] = ((.[$e.key] // []) + $e.value))
    else . end
  | reduce ("allow", "deny", "ask", "additionalDirectories") as $k (.;
      if $f.permissions[$k] then .permissions[$k] = (((.permissions[$k] // []) + $f.permissions[$k]) | dedupe) else . end))
| del(.claudeSetup)
