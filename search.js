// Literal, case-insensitive AND matching. Query text is never a regular expression.
export function searchTerms(query) {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

export function matchesSearch(terms, ...fields) {
  const lowered = fields
    .filter((field) => typeof field === 'string')
    .map((field) => field.toLowerCase());
  return terms.every((term) => lowered.some((field) => field.includes(term)));
}

export function* newestHistory(entries) {
  for (let entry = entries?.last(); entry; entry = entry.prev) yield entry;
}

// Collect at most one page and a lookahead hit. Reading caches must never execute
// commands, and row identities retain the source tab even when texts repeat.
export function collectSearchResults({
  query,
  history,
  historyName,
  sets,
  getGenerated = () => null,
  getPreview = () => null,
  offset = 0,
  limit = 50,
}) {
  const terms = searchTerms(query);
  const groups = [];
  const missing = [];
  let skipped = 0,
    count = 0,
    hasMore = false;
  const visit = (id, name, items) => {
    let group;
    for (const item of items) {
      if (
        !matchesSearch(
          terms,
          item.name,
          item.text,
          item.command,
          getPreview(item)?.text,
        )
      )
        continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      if (count === limit) {
        hasMore = true;
        return false;
      }
      if (!group) {
        group = { id, name, items: [] };
        groups.push(group);
      }
      group.items.push(item);
      count++;
    }
    return true;
  };
  // Notices are independent of pagination, so unloaded generated sources cannot
  // disappear just because history filled the first page of results.
  const generated = new Map();
  for (const set of sets) {
    if (set.kind !== 'generated') continue;
    const record = getGenerated(set);
    generated.set(set.id, record);
    if (record?.state !== 'ready')
      missing.push({
        id: set.id,
        name: set.name,
        state: record?.state || 'unloaded',
      });
  }
  if (visit('history', historyName, history)) {
    for (const set of sets) {
      const items =
        set.kind === 'generated'
          ? generated.get(set.id)?.items || []
          : set.items;
      if (!visit(set.id, set.name, items)) break;
    }
  }
  return { groups, missing, hasMore, count };
}
