MODULES = metadata.json extension.js store.js dataStructures.js confirmDialog.js favoriteNameDialog.js pasteSets.js pasteSetDialog.js commandOutput.js commandSupervisor.py historySession.js i18n.js prefs.js settingsFields.js shortcutModifiers.js stylesheet.css LICENSE README.md schemas/
INSTALLPATH = $(HOME)/.local/share/gnome-shell/extensions/clipboard-history-dev@jidaikobo.shibata/

all: compile-locales compile-settings

compile-settings:
	glib-compile-schemas --strict --targetdir=schemas/ schemas

compile-locales:
	set -e; $(foreach file, $(wildcard locale/*/LC_MESSAGES/clipboard-history-dev.po), \
		msgfmt --check-format $(file) -o $(subst .po,.mo,$(file));)

update-pot:
	xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=N_ \
		--flag=format:1:javascript-format --add-comments=Translators \
		--package-name="Clipboard History (Development)" --package-version=44 \
		--msgid-bugs-address="Report issues to the project maintainer" -o clipboard-history.pot *.js

update-po-files:
	$(foreach file, $(wildcard locale/*/LC_MESSAGES/clipboard-history-dev.po), \
		msgmerge $(file) clipboard-history.pot -o $(file);)

install: all
	@if [ "$$(pwd -P)" = "$$(readlink -m "$(INSTALLPATH)")" ]; then \
		echo "Already in the install directory; use make to build in place."; \
		exit 1; \
	fi
	rm -rf $(INSTALLPATH)
	mkdir -p $(INSTALLPATH)
	cp -r $(MODULES) $(INSTALLPATH)

	$(foreach file, $(wildcard locale/*/LC_MESSAGES/clipboard-history-dev.mo), \
		install -D "$(file)" $(INSTALLPATH)$(file);)

bundle: all
	zip -r bundle.zip $(MODULES) locale/*/LC_MESSAGES/clipboard-history-dev.mo -x schemas/gschemas.compiled
