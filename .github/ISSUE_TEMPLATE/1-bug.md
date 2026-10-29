---
name: 🐛 Bug report
about: Crashes or incorrect behavior
labels: bug
---

### What happened?

Describe what happened and what you expected instead.

### How can we reproduce it?

List the steps. If text is needed to reproduce the issue, use a short, made-up
example without personal or confidential information.

### Versions and environment

- Distribution and version:
- GNOME Shell version:
- Paste Board version:
- Affected application, if any:

These commands show the Shell and extension versions:

```sh
gnome-shell --version
gnome-extensions info paste-board@jidaikobo.shibata
```

### Relevant errors (optional)

You can look for related messages with:

```sh
journalctl --user -b -g 'paste-board' -n 100 --no-pager
```

Review and redact the output before posting it. Include only the relevant error
and stack trace. **Do not upload your clipboard history, paste sets, passwords,
or other private data.**
