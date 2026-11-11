#!/usr/bin/env bash
# Builds the isolated environment every magpie-tasks scenario runs in (plan section 12.2) and prints
# its directory: export E=<that directory> before running a scenario script.
#
#   e2e/setup.sh              notifications stay off Telegram: telegramChatId is `tui` (reports go to
#                             the session's transcript) and telegramStateDir is an empty directory,
#                             so no bot token is found
#   e2e/setup.sh --telegram   the real channel directory (~/.claude/channels/telegram-live): the
#                             scenarios' notifications reach the person's chat; ask them first
#
# Plugins are installed the way they are installed for real, in the same order: subagent-opus, jev,
# context-memory, then magpie-tasks (section 9.15). JEV writes its journal under $E/jev.
set -euo pipefail
REPO=${REPO:-$HOME/sipeng/claude-mods}
telegram=off
[ "${1:-}" = --telegram ] && telegram=live

E=$(mktemp -d /tmp/mt-e2e-XXXX)
mkdir -p "$E/cfg" "$E/state" "$E/wt" "$E/tg" "$E/jev"
cp "$HOME/.config/jev-opus/.env" "$E/jev/.env"
if [ $telegram = live ]; then
  tg_dir="$HOME/.claude/channels/telegram-live"; chat=""
else
  tg_dir="$E/tg"; chat="tui"
fi
jq -n --arg state "$E/state" --arg wt "$E/wt" --arg tg "$tg_dir" --arg chat "$chat" '{
  skipDangerousModePermissionPrompt: true,
  pluginConfigs: { "magpie-tasks@sipeng-mods": { options: { stateDir: $state, worktreeDir: $wt, telegramStateDir: $tg, telegramChatId: $chat } } }
}' > "$E/cfg/settings.json"
# A fresh config directory would open onboarding and folder-trust dialogs in the first pane.
jq -n --arg e "$E" --arg home "$HOME" '{
  hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.319", theme: "dark", autoUpdates: false,
  projects: ([$e, "\($e)/proj", "\($e)/proj2", "\($e)/proj3", "\($e)/repo", $home] | map({ key: ., value: { hasTrustDialogAccepted: true } }) | from_entries)
}' > "$E/cfg/.claude.json"

export CLAUDE_CONFIG_DIR="$E/cfg"
claude plugin marketplace add "$REPO" >/dev/null
for m in subagent-opus jev context-memory magpie-tasks; do
  claude plugin install "$m@sipeng-mods" --scope user >/dev/null
done
echo "$E"
