import {
  searchTerms,
  matchesSearch,
  newestHistory,
  collectSearchResults,
} from '../search.js';
let checks = 0;
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  checks++;
}
equal(searchTerms('  SERVER\tprod\n東京　dev  '), [
  'server',
  'prod',
  '東京',
  'dev',
]);
equal(searchTerms(' \t　'), []);
equal(matchesSearch(searchTerms('server prod'), 'Production server'), true);
equal(matchesSearch(searchTerms('prod server'), 'Server for PROD'), true);
equal(matchesSearch(searchTerms('server prod'), 'server only'), false);
equal(matchesSearch(searchTerms('server prod'), 'server', 'prod'), true);
equal(matchesSearch(searchTerms('(a+)+$'), 'literal (a+)+$ here'), true);
equal(matchesSearch(searchTerms('sver'), 'server'), false);
equal(matchesSearch(searchTerms('東京 本番'), '東京の本番サーバー'), true);
const history = [
  { id: 1, text: 'server prod history' },
  { id: 2, text: 'irrelevant' },
];
const sets = [
  {
    id: 'manual',
    name: 'Saved',
    items: [
      { id: 'm1', name: 'server', text: 'prod manual' },
      {
        id: 'm2',
        kind: 'command',
        name: 'prod',
        text: '',
        command: 'printf server',
      },
    ],
  },
  { id: 'cached', name: 'Generated', kind: 'generated', items: [] },
  { id: 'missing', name: 'Not yet opened', kind: 'generated', items: [] },
];
let reads = 0;
const cache = (set) => {
  reads++;
  return set.id === 'cached'
    ? { state: 'ready', items: [{ id: 'g1', text: 'prod server generated' }] }
    : null;
};
const options = {
  query: 'server prod',
  history,
  historyName: 'History',
  sets,
  getGenerated: cache,
};
let result = collectSearchResults(options);
equal(
  result.groups.map((g) => [g.id, g.items.map((i) => i.id)]),
  [
    ['history', [1]],
    ['manual', ['m1', 'm2']],
    ['cached', ['g1']],
  ],
);
equal(result.missing, [
  { id: 'missing', name: 'Not yet opened', state: 'unloaded' },
]);
equal(result.count, 4);
equal(result.hasMore, false);
equal(reads, 2);
result = collectSearchResults({ ...options, limit: 2 });
equal(
  result.groups.map((g) => g.items.map((i) => i.id)),
  [[1], ['m1']],
);
equal(result.hasMore, true);
equal(result.count, 2);
equal(result.missing.length, 1);
result = collectSearchResults({ ...options, offset: 2, limit: 2 });
equal(
  result.groups.map((g) => g.items.map((i) => i.id)),
  [['m2'], ['g1']],
);
equal(result.hasMore, false);
result = collectSearchResults({ ...options, offset: 4 });
equal(result.groups, []);
equal(result.hasMore, false);
result = collectSearchResults({ ...options, query: 'not present' });
equal(result.count, 0);
equal(result.missing.length, 1);
result = collectSearchResults({
  ...options,
  query: 'special preview',
  getPreview: (item) => (item.id === 'm2' ? { text: 'Special preview' } : null),
});
equal(
  result.groups[0].items.map((i) => i.id),
  ['m2'],
);
result = collectSearchResults({
  ...options,
  getGenerated: (set) =>
    set.id === 'cached' ? { state: 'error', items: [] } : null,
});
equal(
  result.missing.map((i) => i.state),
  ['error', 'unloaded'],
);
const repeated = [
  { id: 'one', text: 'same' },
  { id: 'two', text: 'same' },
];
result = collectSearchResults({
  query: 'same',
  history: repeated,
  historyName: 'H',
  sets: [{ id: 's', name: 'S', items: [{ id: 'one', text: 'same' }] }],
});
equal(result.count, 3);
equal(result.groups.length, 2);
let visited = 0;
function* large() {
  for (let i = 0; i < 10000; i++) {
    visited++;
    yield { id: i, text: 'hit' };
  }
}
result = collectSearchResults({
  query: 'hit',
  history: large(),
  historyName: 'H',
  sets: [],
  limit: 50,
});
equal(result.count, 50);
equal(result.hasMore, true);
equal(visited, 51);
const nodes = [{ text: 'first' }, { text: 'second' }];
nodes[1].prev = nodes[0];
equal(
  [...newestHistory({ last: () => nodes[1] })].map((i) => i.text),
  ['second', 'first'],
);
equal([...newestHistory(null)], []);
print(`Panel search: ${checks} checks passed`);
