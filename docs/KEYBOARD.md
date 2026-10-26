# Keyboard

![Every shortcut, as ⌘/ shows them](images/doc-help.png)

On Windows, ⌘ is Ctrl+Shift, ⇧⌘ is Ctrl+Shift+Alt and ⌥⌘ is Ctrl+Alt; see [Windows](WINDOWS.md#keyboard).

Kuna has two modes. The status bar's left corner always says which one you are in.

- **navigate** — arrows move between the sidebar and the panes. Nothing you press reaches an agent.
- **typing** — every key goes to the focused agent, exactly as in a terminal. The pane gets a violet border.

You enter typing mode by starting to type on a pane (or pressing Enter on it). You leave it by sending (**Enter**) or abandoning (**Esc Esc**).

Launching works the same way from the sidebar: start typing with a folder selected and the text goes into the launch box under the sidebar; **Enter** starts a new agent with it; if it can't start (the host is unreachable, `claude` fails), the text goes back into the box. While the box has text, **← →** move through it and **↑ ↓** between its lines (⌥ and ⌘ arrows jump by word and line, ⇧ arrows select); **↑ ↓** past the first or last line pick the folder: the text stays in the box and the agent starts in the folder that is selected when you press Enter. Backspace edits the box from the sidebar too.

## Moving around

| Keys | Where | Does |
| --- | --- | --- |
| ↑ ↓ | sidebar | move the selection |
| → | sidebar | jump into the panes |
| ← | sidebar | go to the parent row (arrows never roll projects or folders out or in: Enter, Space or a click does) |
| ← → ↑ ↓ | panes | move between panes; ← from the leftmost pane returns to the sidebar (a hidden sidebar slides in, and hides again when you go back → or open an agent with Enter; Esc too); → from the rightmost pane likewise slides in a hidden right panel with the agent's details, until ←, Esc or any other key |
| ⌘1 … ⌘9 | anywhere | focus pane n |
| ⌥← ⌥→ ⌥↑ ⌥↓ | panes | move the focused pane that way, swapping it with the pane there; keep ⌥ held and press again to carry it further (while typing, ⌥← ⌥→ still jump by words) |
| ⇧⌘← / ⇧⌘→ | panes | move the focused pane left / right |
| ⌘S | anywhere | hide or show the left sidebar (and launch box) |
| ⌘B | anywhere | hide or show the right inspector (⌘I works too) |

## Windows

Each window has its own panes; the sidebar is the same in all of them. An agent has one pane across all windows: Enter on an agent that is open in another window goes to that window and its pane.

| Keys | Where | Does |
| --- | --- | --- |
| ⇧⌘N | anywhere | new window, with no panes and the same row selected (also Window → New Window) |
| ⌘← / ⌘→ | navigate | the previous / next window, where you left it, in navigate. Windows go left to right on screen (then top to bottom, then the order they were opened) and the order wraps around. While typing, and in the launch box with text in it, ⌘← ⌘→ stay start / end of the line |
| ⌥⌘← / ⌥⌘→ | panes | carry the focused pane to the previous / next window; the focus goes with it |
| ⇧⌘W | anywhere | close the window: its panes close, the agents keep running. Closing the last one quits Kuna |

The status bar shows which window you are in ("2/3") when there are several, and a window's title (in the Window menu and Mission Control) is the agent of its focused pane. The windows open at quit come back at the next launch, in their places, with their panes; one you closed before quitting does not. A notification goes to the window that has the agent's pane, or opens it in the window you used last.

## Agents

| Keys | Where | Does |
| --- | --- | --- |
| *type* | folder or agent selected | start writing a task for a **new** agent in that folder |
| Enter | sidebar, something typed | start the agent in the selected folder (the box clears) |
| Enter | project or folder, nothing typed | roll it out or in |
| Enter | agent in the sidebar | open it in a pane (or focus its pane) |
| ⌫ | sidebar or launch box | delete from the launch box (⌥⌫ a word, ⌘⌫ the line) |
| *type* | pane | typing mode: the keys go to the agent; arrows edit the text |
| Enter | pane, navigate | typing mode without typing anything (e.g. to use the agent's menus) |
| Enter | typing | send, and return to navigate; answering one of several questions in a row, typing mode stays until none is left on screen |
| ⇧Enter | typing / launch box | new line |
| Esc | panes, typing | Esc for the agent: closes Claude Code's menus and panels such as `/usage` (kept while it is working, where it would interrupt) |
| Esc Esc | typing | leave typing mode and erase what you typed this time |
| ⌘← ⌘→ | typing | jump to the start / end of the line (sent as Ctrl+A / Ctrl+E); ⌥← ⌥→ jump by words |
| Esc Esc | launch box | discard the draft |
| 1 … 9 | pane that needs you | answer a numbered permission prompt without entering typing mode |
| PageUp PageDown | pane, navigate or typing | scroll the agent's conversation a page up or down, as the mouse wheel does; back at the bottom it is live again, and typing, Enter or Esc return there first |
| ⇧Tab | pane, navigate | cycle Claude Code's permission mode (ask → accept edits → plan …) |
| ⌘V | sidebar · pane | paste: in the sidebar into the launch box (to start an agent with it), on a pane into the agent |
| ⌘. | anywhere | interrupt the agent (sends Esc to it) |
| ⌘R | anywhere | rename the selected project, folder or agent (the agent in the focused pane); ⌘E too |
| ⇧⌘R | Kuna agent that exited | resume its conversation (`claude --resume`) in a fresh agent |
| ⇧⌘R | Claude background session | `claude respawn` (restart on the current Claude version); on a stopped one, reopen it |
| ⌘W | pane | close the pane; the agent keeps running. Focus goes back to where you opened it from (the sidebar row or the pane) if you went nowhere else in between |
| Ctrl+X Ctrl+X | pane or sidebar agent | Kuna agent: kill it. Background session: `claude stop` and off the list, no question; the conversation is kept, nothing is deleted. Its pane closes in whichever window has it |
| ⌘Z | navigate | bring back the session Ctrl+X Ctrl+X took off the list last (stopped: Enter opens it). One brought back from `claude agents` shows up again by itself |

A single **Esc** goes to the agent, on a pane or while typing, as in a terminal: it closes Claude Code's menus and panels (`/config`, `/usage`, the slash-command list) and answers "no" to a permission prompt. While the agent is working Kuna keeps it, since in Claude Code it would interrupt the turn (use **⌘.** when you do want to interrupt), unless a panel or question is on its screen, which takes the Esc instead. In tmux scroll mode Esc leaves scroll mode. A second Esc right after the first leaves typing mode; while a panel is open every Esc goes to it (`/config` takes two: one clears its search, the next closes it).

## Looking at things

| Keys | Does |
| --- | --- |
| Space | preview the plots, PDFs and Markdown files of the agent's latest reply, fitted to the window: all PDFs first, then the images, then Markdown, rendered as a page with its pictures, LaTeX math (`$…$`, `$$…$$`) and Mermaid diagrams (newest reply first, in the order the reply names them). A pane's header counts them ("2 pdf 3 img 1 md"); clicking the count opens them too. The file fills the left; on the right are the list of files and, under it, the agent itself, its own terminal as on its pane |
| → / ← | older / newer file (with nothing typed); past the last one, → loads an earlier reply's files, and the folder scan comes last. A click in the list shows that file |
| ↑ ↓, PgUp PgDn | scroll the file (PDF pages, zoomed plots); the wheel over the agent scrolls its conversation |
| *type* | write to the agent beside the file, right away, into its own input box; while something is typed the arrows move between its letters |
| Enter | send it (Claude Code queues it if the agent is mid-turn); ⇧Enter new line, Esc Esc takes what you typed back out. On a stopped background session Enter brings it back first |
| ⌘P | the path of the file in view, into what you are writing |
| ⌘V · ⌘. | paste into your message · interrupt the agent (sends it Esc) |
| ⌘+ ⌘− | zoom in, out (pinch on the trackpad, or ⌘ + wheel, zooms around the pointer) |
| ⌘0 · ⌘1 | fit to the window · actual pixels (100% for a PDF) |
| ⌘O | open the file in its app: Preview for plots and PDFs, your Markdown app for `.md` (an SVG is shown in Finder instead, since its default app is a browser) |
| ⌘U | a Markdown file: switch between the rendered page and its source (also the **Source** / **Rendered** button); the **Copy** button copies the whole file as Markdown |
| ⌘A, ⌘C | a Markdown file: select all of it (rendered or source), copy what is selected |
| ⌘S | save a copy in your Downloads folder (also the **Save to Downloads** button; a taken name becomes `fit (1).pdf`) |
| ⌘R | start over from the latest reply |
| Space or Esc | close (with nothing typed); the agent's terminal goes back to its pane |
| *a panel of the agent's* | while it shows a question, a permission prompt or a panel (`/config`, `/usage`, `/model`), the arrows, Space, Enter and Esc are the agent's: Esc closes the panel, the next Esc the viewer |
| ⌘K | browse `.claude`: skills, agents, commands, `CLAUDE.md`, settings (Tab switches host) |
| ⌘, | colour scheme, fonts, notifications |
| ⌘+ / ⌘− | agent font size (starts from your iTerm2 profile's) |
| ⌘/ | this list, in the app |

## Projects and folders

| Keys | Does |
| --- | --- |
| ⌘N | new project |
| ⌘O | add a folder to the selected project (on an agent under "Other agents": its directory is suggested). Paste a whole path into it, or type with Tab completion; ↑ ↓ walk the listed folders and Enter fills the picked one in (its folders are listed next); Enter with none picked adds the path |
| ⌥↑ / ⌥↓ | move the selected project, folder or agent up or down; keep ⌥ held to carry it further (⇧↑ / ⇧↓ work too) |
| ⌘R | rename the selected project, folder (colour too; `$…$` math allowed) or agent |
| ⌘⌫ | remove the selected folder or project when nothing is typed (agents keep running) |

## Mouse

Click selects; a click on a project or folder rolls it out or in, its ⋯ button renames it. Double-click opens an agent. The mouse wheel (or PageUp / PageDown) scrolls the agent's history (tmux scrollback); typing returns to the bottom first, so the keys reach the agent; dragging selects text there and copies it to the clipboard. Hold **Option** while dragging to select in the terminal itself: the selection is copied when you let go (as in iTerm), and ⌘C copies it again.

- Drag rows in the sidebar to rearrange it: projects above or below each other, folders within a project or into another project on the same host, agents within a folder or into another folder (also out of "Other agents"). A line shows where a row lands; a lit-up row means into it. Kuna remembers where you put agents.
- Drag a pane's header onto another pane to swap the two (⌥ arrows do the same from the keyboard).
- Drag the inner edge of the sidebar or the inspector to resize it; double-click the edge for the default width. Widths are remembered.
- In the plot viewer, pinch to zoom, drag to pan, and double-click to zoom in on a spot (double-click again to fit). Drag the edge between the file and the agent to make the agent's column wider or narrower (remembered; double-click the edge for the default).

## Reading the screen

<img src="images/doc-sidebar.png" width="340" alt="The sidebar in every state">

| In the sidebar | Means |
| --- | --- |
| blue dot | working: mid-turn. The right column says what on ("running", "editing", "subagent") |
| hollow blue dot | between turns with work of its own: a scheduled check ("next 12:05") or jobs running ("2 jobs") |
| amber dot | needs you: a permission prompt or a question, shown in amber under the row. Open it and press the number of your answer |
| grey dot | idle, waiting for the next instruction |
| red dot | failed |
| hollow grey dot | exited or stopped. Enter brings a stopped background session back; ⇧⌘R resumes a Kuna agent's conversation |
| bright name | an agent that is running. Folder names, and agents that exited or were stopped, are dimmer |
| diamond, bold name | finished or asked something since you last looked |
| small square | open in a pane: filled in this window, hollow in another window |
| amber or red gauge | its context is getting long (half the window, or 300k tokens) or almost full (80%; Claude Code will compact it soon) |

A pane's header shows the folder, the agent's name, how many PDFs and images Space would show, its context, model and status in a word ("running", "editing", "2 jobs"). What it is doing in full is in the status's tooltip and in the inspector.

A tab whose agent finished or asked something since you last looked has a lit cyan header marked **new**. Landing on it (arrows, ⌘1–9, a click) clears it. A reply that arrives on the tab you are on stays marked until you leave it and come back.

The inspector on the right (⌘B) shows the focused agent's context use, model, permission mode, token counts, task list, running subagents, recent tool calls, files it changed, and the exact command to attach from any terminal. Its **Compact** button runs `/compact` in the agent (it waits while the agent is mid-turn or asking you; anything half-typed is cleared first, and Ctrl+Y in the agent brings it back).
