const SettingsFields = {
  KEEP_MENU_OPEN: 'keep-menu-open',
  QUICK_PASTE_MODIFIERS: 'quick-paste-modifiers',
  FAVORITE_PASTE_MODIFIERS: 'favorite-paste-modifiers',
  HISTORY_SIZE: 'history-size',
  WINDOW_WIDTH_PERCENTAGE: 'window-width-percentage',
  CACHE_FILE_SIZE: 'cache-size',
  CACHE_ONLY_FAVORITES: 'cache-only-favorites',
  CLEAR_ON_LOGOUT: 'clear-history-on-logout',
  COPY_FEEDBACK: 'copy-feedback',
  NOTIFY_ON_COPY: 'notify-on-copy',
  CONFIRM_ON_CLEAR: 'confirm-clear',
  ENABLE_KEYBINDING: 'enable-keybindings',
  TOPBAR_PREVIEW_SIZE: 'topbar-preview-size',
  TOPBAR_DISPLAY_MODE_ID: 'display-mode',
  DISABLE_DOWN_ARROW: 'disable-down-arrow',
  STRIP_TEXT: 'strip-text',
  PRIVATE_MODE: 'private-mode',
  PASTE_ON_SELECTION: 'paste-on-selection',
  PROCESS_PRIMARY_SELECTION: 'process-primary-selection',
  ENABLE_TYPEAHEAD_SEARCH: 'enable-typeahead-search',
};
export default SettingsFields;

export function migrateSettings(settings) {
  if (settings.get_user_value(SettingsFields.CLEAR_ON_LOGOUT) === null)
    settings.set_boolean(SettingsFields.CLEAR_ON_LOGOUT, settings.get_boolean(SettingsFields.CACHE_ONLY_FAVORITES));
  if (settings.get_user_value(SettingsFields.COPY_FEEDBACK) === null)
    settings.set_int(SettingsFields.COPY_FEEDBACK, settings.get_boolean(SettingsFields.NOTIFY_ON_COPY) ? 2 : 0);
  // Session history now survives locks and extension reloads until logout.
  if (settings.get_boolean(SettingsFields.CACHE_ONLY_FAVORITES))
    settings.set_boolean(SettingsFields.CACHE_ONLY_FAVORITES, false);
}
