## Development quick paste: plain text only

Number shortcuts in the open panel paste history or favorites and restore the
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
- Use the `Only save favorites to disk` feature to wipe your non-favorited items on shutdown.
- Use `Private mode` to temporarily stop processing copied items.
- Use keyboard shortcuts while the panel is open:
  - <kbd>Super</kbd> + a number from 1 to 9 pastes a history item.
  - <kbd>Shift</kbd> + <kbd>Super</kbd> + a number from 1 to 9 pastes a favorite.
  - Both paste shortcuts restore the previous plain text; the bottom switch controls whether the menu stays open.
  - Their modifiers can be changed independently in preferences.
  - <kbd>Esc</kbd> or <kbd>Ctrl</kbd> + <kbd>0</kbd> closes the menu.
  - Pin the menu and choose no extra key, Enter, or Tab after each paste.
    The choice is temporary and resets when unpinned.
  - <kbd>/</kbd> focuses search. Other keys outside search close the panel,
    except modifier keys and configured number shortcuts.
- Search uses case-insensitive [regex](https://regex101.com/?flavor=javascript).

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
