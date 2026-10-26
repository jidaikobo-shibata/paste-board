# Paste Board for GNOME

A plain-text clipboard and paste-set manager for GNOME Shell.
Keep reusable text in tabs, paste with the keyboard, and use Enter or Tab to move
between fields during repeated pasting. Command items generate text when needed.

## Localization

UI source strings are English. Japanese translations cover the panel, preferences,
accessible labels, dialogs, command warnings, and extension-generated errors.
GNOME selects the language from the session locale; untranslated messages fall back
to English. Existing set names, item text, commands, and command output are user data
and are never translated.

Translations use the independent `paste-board` gettext domain in
`locale/<language>/LC_MESSAGES/paste-board.po`. The other language catalogs
retain upstream translations and credits, but do not yet cover all added features.

Run `make` after editing translations to rebuild the installed `.mo` catalogs and
settings schema. For source-string changes, run `make update-pot` and
`make update-po-files`, review translations (including fuzzy entries), then run `make`.
Use English literals inside `_()` and `format()` for translated placeholders;
do not construct message IDs dynamically or translate user data.

`npm test` includes English and Japanese runtime checks. It requires the
`C.utf8` and `ja_JP.utf8` locales, GJS, Python 3, and compiled catalogs (`make`).

## Paste sets

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

Sets are stored separately in `paste-sets.json` under the extension UUID's directory
in the XDG configuration home. They persist independently of the history cache.
Opening the panel always selects History. Pasting while the panel is pinned preserves
the active tab and search filter. Left/Right outside search switches tabs and focuses the first item.
Number shortcuts always refer to the visible tab; only the item numbers are shown.

### Command items

Edit an item in a custom tab and select “Command” instead of “Text”.
For example, name an item “Current date” and enter `date '+%Y-%m-%d %H:%M:%S'`.
Click, Enter, and number shortcuts run it afresh and paste its standard output.
Opening, searching, editing, dragging, or saving an item never runs it.
Pasting output is temporary: the original clipboard is restored and output is not added to history.
With “Paste on Enter or click” disabled, explicit copy-only actions put output into
the clipboard and ordinary history instead.

The editor offers “Direct execution” and “Bash (one-liner)”. Direct execution groups
quoted arguments without interpreting shell expansions or operators. Select Bash to use
shell syntax.

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
The optional “Trim trailing newlines” setting defaults to on; it removes trailing LF/CRLF only,
preserving leading whitespace, internal newlines, and spaces.
Closing the panel or disabling the extension cancels the running command. A changed target window,
clipboard, or privacy state prevents a late result from being pasted. A bundled supervisor uses
Ubuntu's `/usr/bin/python3` standard library (no third-party Python packages) to own a new session
and process group. Cancellation, timeout, or output overflow terminates the supervisor and normal
pipeline children in that group, even after the command's original leader exits.
Commands that deliberately create separate process groups or sessions can escape this cleanup;
this is process management, not a security sandbox. Direct execution retains the Shell's working
directory; Bash uses the home directory.

## Plain-text pasting

Number shortcuts in the open panel paste from the active history or paste-set tab and restore the
previous clipboard **as plain text**. Formatting, images, and application-specific
clipboard metadata are not preserved. If the previous clipboard cannot be read
as text, it is treated as empty text. Non-text data cannot be restored by this
plain-text extension.

Number shortcuts close the history panel after paste by default. Enable the
“Pin the panel” switch at the bottom to keep it open for repeated pastes.
Clicking the pin enables this immediately, initially with no extra key after paste;
the displayed options can then select Enter or Tab as the post-paste action.
Enter and clicks also honor this switch; Esc closes the panel.
Their modifiers are configurable in preferences. This implementation uses the
GNOME Shell clipboard and virtual keyboard directly, without an Xwayland helper.
Clipboard restoration currently waits 100 ms; application-level paste completion
is not acknowledged, so unusually slow applications require manual verification.

## Preference behavior

The popup is called the paste panel. Its width setting is “Panel width (%)”.
The opener shortcut and in-panel number modifier are independent; disabling the opener
shortcut does not disable number-key paste inside an already open panel.

The first item in unfiltered History represents the current text clipboard; there is
no selection dot. Ordinary copies and unpinned Enter/click selection in History
always move that text to the top and make it the current clipboard. This behavior
is fixed rather than controlled by a preference. Search and pagination can show
other portions of history without changing the clipboard. Reopening the panel starts
at the first page. On activation, an empty clipboard is restored from the first saved
history item; an existing clipboard containing non-text data is left untouched.
An explicitly emptied clipboard has no current text item until a new copy is made.

Pinned pastes, number-key pastes, and pastes from sets restore the previous clipboard
and preserve history order. Set item order never changes as a result of pasting.
PRIMARY-selection capture remains optional: selected text is placed immediately below
the current clipboard item, preserving both the current clipboard and the first item.

“Paste on Enter or click” applies to all tabs. When off, Enter/click copies only;
command items run and copy their output. Copy-only actions update the current clipboard
and put their text at the top of ordinary history, including when pinned or using a set.
Number shortcuts always paste. The pin controls panel closure for both paste and copy-only
selection. Enabling whitespace trimming normalizes both captured clipboard text and
history; PRIMARY capture never changes the clipboard.

Copy feedback choices are off, icon, icon plus bubble, whole top bar, OS notification,
and whole top bar plus bubble. Bubbles appear below the extension icon when visible,
or below the center of the top bar when the icon is hidden. The bar flashes for
350 ms and the bubble lasts 800 ms, including when animations are disabled.
OS notifications say only “Copied” (localized), never the copied text, and honor notification policy.
Full history deletion always requires confirmation; there is no preference to skip it.

“Clear history on logout” removes ordinary history and preserves paste sets.
History remains available across locks and extension reloads within the same login session.
While enabled, the extension listens for SessionOver. It also records boot/login identity
and a pending-cleanup marker so interrupted cleanup or logout while the extension is disabled
cannot restore the previous session's history on next activation in a new session.
If the extension is disabled at logout, physical cleanup occurs at next activation.
This is ordinary file replacement, not a secure disk-erasure guarantee.

## Build and install from this checkout

Run `make` to compile translations and settings schemas. Then run `make install`
to link this checkout into the GNOME Shell extensions directory. Existing unrelated
installations are never overwritten. GNOME Shell requires the directory name
`paste-board@jidaikobo.shibata` to match the extension UUID.

On Wayland, log out and log back in after installing or changing Shell code.
Enable **Paste Board for GNOME** in the Extensions application. The default panel
shortcut is **Super+F1**. Use the isolated development Shell script in
`scripts/start-dev-shell.sh` to test without restarting the normal desktop.

## Origins and license

Paste Board for GNOME is derived from
[Gnome Clipboard History](https://github.com/SUPERCILEX/gnome-clipboard-history)
by SUPERCILEX, itself derived from
[Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator).
The original project's technical overview is available at
[alexsaveau.dev](https://alexsaveau.dev/blog/gch).
Existing copyright notices and translator credits are preserved. See `LICENSE`
for the MIT License terms.
