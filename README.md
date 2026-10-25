## Paste sets (experimental)

Tabs separate automatic clipboard history from independent, manually ordered paste sets.
Use the new-tab icon in the bottom toolbar to create a set. Drag a history item onto a set tab to copy it there; dragging between sets also copies.
The source item is preserved. Row controls edit names and text, reorder, or delete items.
Dropping an item onto unused space in the tab strip creates an `untitled` set containing a copy
and activates it after the drag ends. Duplicate names use `untitled 2`, `untitled 3`, and so on.
Command execution mode and output options are copied too; dropping never executes a command.
Drops outside the tab strip do not create sets.
The history row's add button is an alternative way to copy into a chosen set. Editing a copy does not affect history or other sets.
Set and item deletion require confirmation. The bottom toolbar's edit button renames the current tab and offers confirmed deletion
for sets. The history tab can be renamed but cannot be deleted.

Existing favorites are copied once, in their original visible order, into a set named
「お気に入り」. Original favorites and the history log remain intact for rollback.
Sets are stored separately in `paste-sets.json` under the extension UUID's directory
in the XDG configuration home. They persist independently of the history cache.
Opening the menu always selects History. Pasting while the menu is pinned preserves
the active tab and search filter. Left/Right outside search switches tabs and focuses the first item.
Number shortcuts always refer to the visible tab; only the item numbers are shown.

### Command items

Edit an item in a custom tab and select 「コマンド」 instead of 「テキスト」.
For example, name an item “Current date” and enter `date '+%Y-%m-%d %H:%M:%S'`.
Click, Enter, and number shortcuts run it afresh and paste its standard output.
Opening, searching, editing, dragging, or saving an item never runs it.
The output is temporary: the original clipboard is restored and output is not added to history.

The editor offers 「直接実行」 and 「Bash（ワンライナー）」. Existing items without a stored
execution mode retain direct execution: quotes group arguments, but shell expansions and
operators are not interpreted. Switch an item explicitly to Bash to enable shell syntax.

Bash items run using `/bin/bash --noprofile --norc -o pipefail -c`, with the home directory
as the working directory and GNOME Shell's environment and PATH. Pipes, redirects, variables,
command substitution and other Bash syntax are supported. Startup files are not loaded;
`BASH_ENV`, `ENV`, `SHELLOPTS` and `BASHOPTS` are removed from the child environment.
Aliases and functions from interactive shell configuration are not automatically available.
A failed pipeline stage causes the item to fail, even if its final stage succeeds.
Use single quotes in Bash for text that must stay literal.

**Commands execute with your user permissions. They can modify or delete files, communicate
over the network, or start applications. They execute even if they produce no output.
Only register commands you understand and trust; this is not a sandbox. Timeouts and
cancellation do not undo actions already performed.**

Interactive input is unsupported. The extension does not acquire, store, or supply passwords.
No terminal is allocated, and stdin is `/dev/null`. Authentication requested independently by
a launched program is not managed by the extension; operations already authorized by the OS
can still proceed. Execution is asynchronous, limited to 3 seconds and 64 KiB of
combined stdout/stderr; failures, empty output, NUL characters, and invalid UTF-8 are not pasted.
The optional 「末尾の改行を削除する」 setting defaults to on; it removes trailing LF/CRLF only,
preserving leading whitespace, internal newlines, and spaces.
Closing the menu or disabling the extension cancels the running command. A changed target window,
clipboard, or privacy state prevents a late result from being pasted. A bundled supervisor uses
Ubuntu's `/usr/bin/python3` standard library (no third-party Python packages) to own a new session
and process group. Cancellation, timeout, or output overflow terminates the supervisor and normal
pipeline children in that group, even after the command's original leader exits.
Commands that deliberately create separate process groups or sessions can escape this cleanup;
this is process management, not a security sandbox. Direct execution retains the Shell's working
directory; Bash uses the home directory.

## Development quick paste: plain text only

Number shortcuts in the open menu paste from the active history or paste-set tab and restore the
previous clipboard **as plain text**. Formatting, images, and application-specific
clipboard metadata are not preserved. If the previous clipboard cannot be read
as text, quick paste is cancelled without replacing it.

Number shortcuts close the history menu after paste by default. Enable the
“メニューを維持” switch at the bottom to keep it open for repeated pastes.
Enter and clicks also honor this switch; Esc closes the menu.
Their modifiers are configurable in preferences. This implementation uses the
GNOME Shell clipboard and virtual keyboard directly, without an Xwayland helper.
Clipboard restoration currently waits 100 ms; application-level paste completion
is not acknowledged, so unusually slow applications require manual verification.

# Gnome Clipboard History

[Gnome Clipboard History](https://extensions.gnome.org/extension/4839/clipboard-history/) is a
clipboard manager GNOME extension that saves what you've copied into an easily accessible,
searchable history panel.

The extension is a rewrite of
[Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) with
vastly improved performance, new features, and
[bug fixes](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/pull/338).

A technical overview is available at https://alexsaveau.dev/blog/gch.

## Project status: replaced by Ringboard

Gnome Clipboard History is now in maintenance mode as it is being replaced by
[Ringboard](https://github.com/SUPERCILEX/clipboard-history). I'm still accepting PRs for small
improvements and bug fixes (such as supporting the latest Gnome version), but no new development
will take place.

## Download

[<img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/eb9af9a1c6f04eb060cb01de6aeb5c84232cd8c0/get-it-on-ego.svg?sanitize=true" alt="Get it on GNOME Extensions" height="100" align="middle">](https://extensions.gnome.org/extension/4839/clipboard-history/)

## Tips

![Tutorial screenshot](tutorial-screenshot.png)

- Open the panel from anywhere with <kbd>Super</kbd> + <kbd>F1</kbd>.
- Modify shortcuts in settings or delete them by hitting backspace while editing a shortcut.
- History can be kept in memory only; paste sets are saved independently.
- Use `Private mode` to temporarily stop processing copied items.
- Use keyboard shortcuts while the panel is open:
  - <kbd>Super</kbd> + a number from 1 to 9 pastes from the visible tab.
  - Number shortcuts restore the previous plain text; the bottom switch controls whether the menu stays open.
  - The modifier combination can be changed in preferences.
  - <kbd>Esc</kbd> or <kbd>Ctrl</kbd> + <kbd>0</kbd> closes the menu.
  - Pin the menu and choose no extra key, Enter, or Tab after each paste.
    The choice is temporary and resets when unpinned.
  - <kbd>/</kbd> focuses search. Other keys outside search close the panel,
    except modifier keys and configured number shortcuts.
- History search supports case-insensitive regular expressions. Paste-set search matches names and text literally, without case sensitivity.

## Install from source

A note on versioning:

- The `master` branch and `1.4.x` tags support GNOME 45.
- The `pre-45` branch and `1.3.x` (or earlier) tags support GNOME 40-44.

### Build

```shell
cd ~/.local/share/gnome-shell/extensions/ && \
  git clone https://github.com/SUPERCILEX/gnome-clipboard-history.git clipboard-history@alexsaveau.dev && \
  cd clipboard-history@alexsaveau.dev && \
  make
```

### Restart GNOME

<kbd>Alt</kbd> + <kbd>F2</kbd> then type `r`.

### Install

```shell
gnome-extensions enable clipboard-history@alexsaveau.dev
```
