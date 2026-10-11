// Portable settings bits, independent of toolkit modifier masks.
export function modifierLabel(value) {
  return [[1, 'Ctrl'], [2, 'Alt'], [4, 'Shift'], [8, 'Super']]
    .filter(([bit]) => value & bit).map(([, name]) => name).join('+');
}

export function modifierBits(state, masks) {
  return (state & masks.CONTROL_MASK ? 1 : 0) |
    (state & masks.MOD1_MASK ? 2 : 0) |
    (state & masks.SHIFT_MASK ? 4 : 0) |
    (state & (masks.MOD4_MASK | masks.SUPER_MASK) ? 8 : 0);
}

export function pasteTarget(bits, history, favorites) {
  if (!bits || history === favorites)
    return null;
  return bits === history ? 'history' : bits === favorites ? 'favorites' : null;
}

export function modifierBadge(value) {
  return [[1, '⌃'], [2, '⌥'], [4, '⇧'], [8, '◆']]
    .filter(([bit]) => value & bit).map(([, symbol]) => symbol).join('');
}
