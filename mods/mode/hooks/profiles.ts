// Keys a mode owns in .claude/settings.local.json. General writes the global
// values back, so an explicit choice is recorded in the file and silences the
// paper-repo hint. Both modes reply in Plain; academic judgment is a system
// prompt section added by register.ts, not an output style.

export type ModeName = 'general' | 'academic'

export type Profile = {
  enabledPlugins: Record<string, boolean>
  outputStyle: string
}

export const WRITING = 'superpower-writing@superpower-writing'
export const PLANNING = 'superpower-planning@superpower-planning'

export const PROFILES: Record<ModeName, Profile> = {
  academic: {
    enabledPlugins: { [WRITING]: true, [PLANNING]: false },
    outputStyle: 'Plain',
  },
  general: {
    enabledPlugins: { [WRITING]: false, [PLANNING]: true },
    outputStyle: 'Plain',
  },
}
