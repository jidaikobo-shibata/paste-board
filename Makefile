.PHONY: all compile-settings compile-locales update-pot update-po-files install bundle

MODULES = commandPreviews.js clipboardRead.js inputLimits.js metadata.json extension.js store.js dataStructures.js confirmDialog.js pasteSets.js pasteSetDialog.js commandOutput.js copyFeedback.js pasteShortcuts.js appPastePrefs.js commandSupervisor.py historySession.js i18n.js prefs.js settingsFields.js shortcutModifiers.js stylesheet.css LICENSE README.md screenshot.png schemas/ icons/
INSTALLPATH = $(HOME)/.local/share/gnome-shell/extensions/paste-board@jidaikobo.shibata

all: compile-locales compile-settings

compile-settings:
	glib-compile-schemas --strict --targetdir=schemas/ schemas

compile-locales:
	set -e; $(foreach file, $(wildcard locale/*/LC_MESSAGES/paste-board.po), \
		msgfmt --check-format $(file) -o $(subst .po,.mo,$(file));)

update-pot:
	xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=N_ \
		--flag=format:1:javascript-format --add-comments=Translators \
		--package-name="Paste Board for GNOME" --package-version=44 \
		--msgid-bugs-address="Report issues to the project maintainer" -o paste-board.pot *.js

update-po-files:
	$(foreach file, $(wildcard locale/*/LC_MESSAGES/paste-board.po), \
		msgmerge $(file) paste-board.pot -o $(file);)

install: all
	@mkdir -p "$$(dirname "$(INSTALLPATH)")"
	@if [ -e "$(INSTALLPATH)" ] || [ -L "$(INSTALLPATH)" ]; then \
		if [ "$$(pwd -P)" = "$$(readlink -f "$(INSTALLPATH)")" ]; then \
			echo "This checkout is already installed."; \
		else \
			echo "Refusing to overwrite an existing extension at $(INSTALLPATH)." >&2; \
			exit 1; \
		fi; \
	else \
		ln -s "$$(pwd -P)" "$(INSTALLPATH)"; \
	fi

bundle: all
	@set -e; paste_board_bundle_root=$$(mktemp -d /tmp/paste-board-bundle.XXXXXX); \
	trap 'rm -rf -- "$$paste_board_bundle_root"' EXIT; \
	zip -r "$$paste_board_bundle_root/paste-board.zip" $(MODULES) \
		locale/*/LC_MESSAGES/paste-board.mo -x schemas/gschemas.compiled; \
	mv "$$paste_board_bundle_root/paste-board.zip" paste-board.zip
