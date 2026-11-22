/**
 * Slash commands to offer while one is typed where Claude Code's own list is
 * not on screen (the iPhone's prompt): Claude Code's own, and the commands and
 * skills found on the host.
 */

export interface SlashCommand {
  /** as typed, with its slash */
  name: string
  about: string
}

/** Claude Code's own commands: the ones worth typing from a phone. */
export const SLASH_COMMANDS: SlashCommand[] = (
  [
    ['add-dir', 'Add another working directory'],
    ['agents', 'Subagents'],
    ['clear', 'Start a new conversation'],
    ['compact', 'Summarise the conversation to free its context'],
    ['config', 'Settings'],
    ['context', 'What fills the context'],
    ['cost', 'Tokens and cost of this session'],
    ['doctor', 'Check the installation'],
    ['effort', 'How hard it thinks'],
    ['export', 'Export the conversation'],
    ['help', 'Commands and shortcuts'],
    ['hooks', 'Hooks'],
    ['init', 'Write a CLAUDE.md for the folder'],
    ['mcp', 'MCP servers'],
    ['memory', 'Edit the memory files'],
    ['model', 'Switch model'],
    ['permissions', 'What it may do without asking'],
    ['plugin', 'Plugins'],
    ['pr-comments', "A pull request's comments"],
    ['resume', 'Go back to an earlier conversation'],
    ['review', 'Review a pull request'],
    ['rewind', 'Undo back to an earlier message'],
    ['security-review', 'Review the pending changes for security'],
    ['status', 'Version, model and account'],
    ['todos', 'Its to-do list'],
    ['usage', 'How much of the plan is used']
  ] as const
).map(([name, about]) => ({ name: `/${name}`, about }))

/**
 * `kuna claude-files` output → the commands and skills of the user (`G`), the
 * project (`L`) and installed plugins (`P`, as `plugin:name`), by the name
 * they are typed with.
 */
export function slashFromFiles(text: string): SlashCommand[] {
  const out = new Map<string, SlashCommand>()
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const scope = line.slice(0, tab)
    const path = line.slice(tab + 1)
    // a plugin as it is installed (cache/<marketplace>/<plugin>/<version>/…), not the marketplace's catalogue
    const plugin = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/(?=skills\/|commands\/)/.exec(path)
    if (scope === 'P' && !plugin) continue
    const skill = /\/skills\/(?:.*\/)?([^/]+)\/SKILL\.md$/.exec(path)
    const command = /\/commands\/(.+)\.md$/.exec(path)
    const own = skill ? skill[1] : command ? command[1].replace(/\//g, ':') : null
    if (!own) continue
    const name = `/${scope === 'P' ? `${plugin![1]}:` : ''}${own}`
    if (!out.has(name)) out.set(name, { name, about: scope === 'P' ? 'plugin' : scope === 'L' ? 'this project' : skill ? 'your skill' : 'your command' })
  }
  return [...out.values()]
}

/**
 * What to offer for what is typed so far: only while it is one word starting
 * with a slash. Names that start with it first, then names that contain it.
 */
export function slashMatches(typed: string, found: SlashCommand[] = [], max = 8): SlashCommand[] {
  if (!/^\/[^\s/]*$/.test(typed)) return []
  const q = typed.slice(1).toLowerCase()
  const all = [...SLASH_COMMANDS, ...found.filter((f) => !SLASH_COMMANDS.some((c) => c.name === f.name))]
  const starts = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q))
  const holds = q ? all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q)) : []
  return [...starts, ...holds].filter((c) => c.name !== typed).slice(0, max)
}
