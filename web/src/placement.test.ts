import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `panes.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no placement.js for `node --test` to find.
import {
  applyPlacements,
  dropBox,
  dropView,
  loadPlacements,
  MAX_BOX_WIDTH,
  MAX_PLACEMENTS,
  MAX_PROJECTS,
  MAX_VIEWS,
  MIN_BOX_WIDTH,
  parseStore,
  placeBox,
  PLACEMENT_VERSION,
  readView,
  serializeStore,
  STORAGE_KEY,
  viewKeyOf,
  withoutPlacement,
  withoutView,
  withPlacement,
  type Placement,
  type Placements,
  type Store,
} from './placement.ts';

type ViewSpec = Parameters<typeof viewKeyOf>[0];

const SPEC: ViewSpec = {
  scope: '',
  focus: null,
  depth: 1,
  filter: {
    hidePath: '',
    onlyPath: '',
    kinds: [],
    edgeKinds: ['imports', 'extends', 'implements'],
    sinceMs: 0,
    onlyChanged: false,
    hideTests: false,
  },
  at: null,
  diagram: 'classes',
};

const spec = (extra: Partial<ViewSpec> = {}): ViewSpec => ({ ...SPEC, ...extra });
const key = (extra: Partial<ViewSpec> = {}): string => {
  const answer = viewKeyOf(spec(extra), 'diagram');
  assert.notEqual(answer, null);
  return answer ?? '';
};

const ROOT = '/Users/x/proj';

/** A store with one placement in one view of one project. */
function one(id = 'src/a.ts', placement: Placement = { x: 40, y: 80 }): Store {
  return withPlacement(new Map(), ROOT, key(), id, placement);
}

// --- the view key ------------------------------------------------------------

test('a list has no key, so a list can store nothing', () => {
  assert.equal(viewKeyOf(spec(), 'list'), null);
  assert.equal(viewKeyOf(spec({ scope: 'src/view' }), 'list'), null);
  // And the same view drawn as a diagram does have one.
  assert.notEqual(viewKeyOf(spec({ scope: 'src/view' }), 'diagram'), null);
});

test('the place is in the key', () => {
  const root = key();
  assert.notEqual(key({ scope: 'src/view' }), root);
  assert.notEqual(key({ focus: 'src/a.ts' }), root);
  assert.notEqual(key({ category: 'group-7' }), root);
  assert.notEqual(key({ diagram: 'components' }), root);
  // Two different places are two different keys, not merely both non-root.
  assert.notEqual(key({ scope: 'src/view' }), key({ scope: 'src/graph' }));
  assert.notEqual(key({ focus: 'src/a.ts' }), key({ focus: 'src/b.ts' }));
});

test('a diff is its own picture, because it echoes no scope', () => {
  // Without this the diff of a whole project and the root diagram would share
  // one key: `diff` drops scope, focus and category from the echoed spec.
  assert.notEqual(key({ diff: 'base' }), key());
  // ... and the span compared is not part of the place. `diff=base` resolves
  // to a new sha on every commit, and a key per sha compared would mint one
  // key an afternoon.
  assert.equal(key({ diff: 'base' }), key({ diff: 'a1b2c3d' }));
});

test('what changes which boxes are drawn is not in the key', () => {
  const scoped = key({ scope: 'src/view' });
  // A filter takes boxes away and puts them back; the ones that come back
  // belong where they were left.
  assert.equal(key({ scope: 'src/view', filter: { ...SPEC.filter, hideTests: true } }), scoped);
  assert.equal(key({ scope: 'src/view', filter: { ...SPEC.filter, onlyChanged: true } }), scoped);
  assert.equal(key({ scope: 'src/view', filter: { ...SPEC.filter, edgeKinds: ['calls'] } }), scoped);
  // A focus at depth 2 is the same centre with more neighbours round it.
  assert.equal(key({ focus: 'src/a.ts', depth: 2 }), key({ focus: 'src/a.ts', depth: 1 }));
  // Last week's diagram lines up with this week's, which is why you freeze one.
  assert.equal(key({ scope: 'src/view', at: 'deadbee' }), scoped);
  // Forcing a diagram and finding one by the threshold are the same picture.
  assert.equal(key({ scope: 'src/view', as: 'diagram' }), scoped);
});

test('a key survives a separator living inside a path', () => {
  // A path may legally hold whatever separator a joined string would use, and
  // two views quietly sharing a key is placements landing on boxes nobody
  // placed. Same characters, two different views, two different keys.
  assert.notEqual(key({ scope: 'a"], "b' }), key({ scope: 'a', category: 'b' }));
  assert.notEqual(key({ scope: 'a\nb' }), key({ scope: 'a', focus: 'b' }));
});

// --- the merge ---------------------------------------------------------------

interface Box {
  id: string;
  position: { x: number; y: number };
  width?: number;
}

const box = (id: string, x: number, y: number): Box => ({ id, position: { x, y }, width: 240 });

test('a placement wins over the computed position, and nothing else moves', () => {
  const boxes = [box('a.ts', 0, 0), box('b.ts', 300, 0), box('c.ts', 600, 0)];
  const placed: Placements = new Map([['b.ts', { x: -120, y: 480 }]]);
  const after = applyPlacements(boxes, placed);

  assert.deepEqual(after[1]?.position, { x: -120, y: 480 });
  assert.deepEqual(after[0]?.position, { x: 0, y: 0 });
  assert.deepEqual(after[2]?.position, { x: 600, y: 0 });
  // The untouched boxes are the very same objects, so React Flow sees no change.
  assert.equal(after[0], boxes[0]);
  assert.equal(after[2], boxes[2]);
});

test('a width applies when there is one, and the ordinary width stands when there is not', () => {
  const boxes = [box('a.ts', 0, 0), box('b.ts', 300, 0)];
  const after = applyPlacements(
    boxes,
    new Map([
      ['a.ts', { x: 0, y: 0, width: 520 }],
      ['b.ts', { x: 300, y: 0 }],
    ]),
  );
  assert.equal(after[0]?.width, 520);
  assert.equal(after[1]?.width, 240);
});

test('a placement for a box this view does not draw applies to nothing', () => {
  const boxes = [box('a.ts', 0, 0)];
  const after = applyPlacements(boxes, new Map([['gone.ts', { x: 900, y: 900 }]]));
  assert.deepEqual(after.map((b) => b.id), ['a.ts']);
  assert.deepEqual(after[0]?.position, { x: 0, y: 0 });
});

test('two boxes placed on top of each other stay on top of each other', () => {
  // Somebody put them there. Inventing avoidance would move a box a person
  // placed, which is the one thing this file exists to stop.
  const after = applyPlacements(
    [box('a.ts', 0, 0), box('b.ts', 300, 0)],
    new Map([
      ['a.ts', { x: 100, y: 100 }],
      ['b.ts', { x: 100, y: 100 }],
    ]),
  );
  assert.deepEqual(after[0]?.position, after[1]?.position);
});

test('no placements is the layout untouched', () => {
  const boxes = [box('a.ts', 0, 0)];
  assert.deepEqual(applyPlacements(boxes, new Map()), boxes);
});

// --- writing -----------------------------------------------------------------

test('a placement is stored under its project and its view, rounded', () => {
  const store = withPlacement(new Map(), ROOT, key(), 'src/a.ts', { x: 40.4, y: -80.6 });
  assert.deepEqual([...readView(store, ROOT, key())], [['src/a.ts', { x: 40, y: -81 }]]);
  // ... and nowhere else.
  assert.equal(readView(store, ROOT, key({ scope: 'src/view' })).size, 0);
  assert.equal(readView(store, '/other/proj', key()).size, 0);
});

test('a store is not mutated by a write to it', () => {
  const before = one();
  const after = withPlacement(before, ROOT, key(), 'src/b.ts', { x: 0, y: 0 });
  assert.equal(readView(before, ROOT, key()).size, 1);
  assert.equal(readView(after, ROOT, key()).size, 2);
});

test('a width is clamped at both ends, and a placement with none keeps none', () => {
  const store = withPlacement(
    withPlacement(withPlacement(new Map(), ROOT, key(), 'wide', { x: 0, y: 0, width: 5000 }), ROOT, key(), 'thin', {
      x: 0,
      y: 0,
      width: 12,
    }),
    ROOT,
    key(),
    'plain',
    { x: 0, y: 0 },
  );
  const view = readView(store, ROOT, key());
  assert.equal(view.get('wide')?.width, MAX_BOX_WIDTH);
  assert.equal(view.get('thin')?.width, MIN_BOX_WIDTH);
  assert.equal('width' in (view.get('plain') ?? {}), false);
});

test('a placement that is not a pair of finite numbers is refused outright', () => {
  // A NaN reaching dagre or a frame's bounds is an unreadable diagram, not a
  // wrong pixel, so it never enters the store.
  const store = one();
  assert.equal(withPlacement(store, ROOT, key(), 'bad', { x: Number.NaN, y: 0 }), store);
  assert.equal(withPlacement(store, ROOT, key(), 'bad', { x: 0, y: Infinity }), store);
  // A width that is not a number costs only the width.
  const kept = withPlacement(store, ROOT, key(), 'ok', { x: 1, y: 2, width: Number.NaN });
  assert.deepEqual(readView(kept, ROOT, key()).get('ok'), { x: 1, y: 2 });
});

test('a null key is a no-op everywhere', () => {
  const store = one();
  assert.equal(withPlacement(store, ROOT, null, 'src/a.ts', { x: 1, y: 1 }), store);
  assert.equal(withoutPlacement(store, ROOT, null, 'src/a.ts'), store);
  assert.equal(withoutView(store, ROOT, null), store);
  assert.equal(readView(store, ROOT, null).size, 0);
});

// --- the ways back -----------------------------------------------------------

test('one box goes back where the layout wanted it, and its neighbours do not', () => {
  const store = withPlacement(one('src/a.ts'), ROOT, key(), 'src/b.ts', { x: 300, y: 0 });
  const after = withoutPlacement(store, ROOT, key(), 'src/a.ts');
  assert.deepEqual([...readView(after, ROOT, key()).keys()], ['src/b.ts']);
  // Dropping something that was never placed changes nothing at all.
  assert.equal(withoutPlacement(after, ROOT, key(), 'src/a.ts'), after);
});

test('re-layout drops the whole view, and only that view', () => {
  const store = withPlacement(one('src/a.ts'), ROOT, key({ scope: 'src/view' }), 'src/view/x.ts', { x: 9, y: 9 });
  const after = withoutView(store, ROOT, key());
  assert.equal(readView(after, ROOT, key()).size, 0);
  assert.equal(readView(after, ROOT, key({ scope: 'src/view' })).size, 1);
});

test('re-layout drops placements for boxes a filter is hiding too', () => {
  // Re-laying out the drawn half and leaving the hidden half placed would put
  // the arrangement back the moment the filter came off.
  let store = one('src/a.ts');
  store = withPlacement(store, ROOT, key(), 'src/a.test.ts', { x: 500, y: 0 });
  assert.equal(readView(store, ROOT, key()).size, 2);
  assert.equal(readView(withoutView(store, ROOT, key()), ROOT, key()).size, 0);
});

// --- the caps ----------------------------------------------------------------

test('re-placing a box refreshes its recency without adding an entry', () => {
  let store = one('a');
  store = withPlacement(store, ROOT, key(), 'b', { x: 1, y: 1 });
  store = withPlacement(store, ROOT, key(), 'a', { x: 2, y: 2 });
  assert.deepEqual([...readView(store, ROOT, key()).keys()], ['b', 'a']);
  assert.equal(readView(store, ROOT, key()).size, 2);
});

test('past the per-view cap the least recently placed box goes back to the layout', () => {
  let store: Store = new Map();
  for (let index = 0; index < MAX_PLACEMENTS + 3; index++) {
    store = withPlacement(store, ROOT, key(), `box-${index}`, { x: index, y: 0 });
  }
  const view = readView(store, ROOT, key());
  assert.equal(view.size, MAX_PLACEMENTS);
  assert.equal(view.has('box-0'), false);
  assert.equal(view.has('box-2'), false);
  assert.equal(view.has('box-3'), true);
  assert.equal(view.has(`box-${MAX_PLACEMENTS + 2}`), true);
});

test('a box kept alive by re-placing it outlives newer ones', () => {
  let store: Store = new Map();
  for (let index = 0; index < MAX_PLACEMENTS; index++) {
    store = withPlacement(store, ROOT, key(), `box-${index}`, { x: index, y: 0 });
  }
  store = withPlacement(store, ROOT, key(), 'box-0', { x: 999, y: 0 });
  store = withPlacement(store, ROOT, key(), 'newcomer', { x: 0, y: 0 });
  const view = readView(store, ROOT, key());
  assert.deepEqual(view.get('box-0'), { x: 999, y: 0 });
  assert.equal(view.has('box-1'), false);
  assert.equal(view.has('newcomer'), true);
});

test('past the per-project cap the least recently arranged view goes', () => {
  let store: Store = new Map();
  for (let index = 0; index < MAX_VIEWS + 1; index++) {
    store = withPlacement(store, ROOT, key({ scope: `dir-${index}` }), 'a', { x: 0, y: 0 });
  }
  assert.equal(store.get(ROOT)?.size, MAX_VIEWS);
  assert.equal(readView(store, ROOT, key({ scope: 'dir-0' })).size, 0);
  assert.equal(readView(store, ROOT, key({ scope: 'dir-1' })).size, 1);
});

test('past the project cap the least recently arranged project goes', () => {
  let store: Store = new Map();
  for (let index = 0; index < MAX_PROJECTS + 1; index++) {
    store = withPlacement(store, `/proj-${index}`, key(), 'a', { x: 0, y: 0 });
  }
  assert.equal(store.size, MAX_PROJECTS);
  assert.equal(readView(store, '/proj-0', key()).size, 0);
  assert.equal(readView(store, `/proj-${MAX_PROJECTS}`, key()).size, 1);
});

// --- the wire format ---------------------------------------------------------

test('a store round-trips, recency and all', () => {
  let store = one('src/a.ts', { x: 40, y: 80 });
  store = withPlacement(store, ROOT, key(), 'src/b.ts', { x: 300, y: 0, width: 400 });
  store = withPlacement(store, '/other', key({ focus: 'x.ts' }), 'x.ts', { x: -1, y: -2 });

  const back = parseStore(serializeStore(store));
  assert.deepEqual([...readView(back, ROOT, key())], [
    ['src/a.ts', { x: 40, y: 80 }],
    ['src/b.ts', { x: 300, y: 0, width: 400 }],
  ]);
  assert.deepEqual([...readView(back, '/other', key({ focus: 'x.ts' })).keys()], ['x.ts']);
  assert.deepEqual([...back.keys()], [ROOT, '/other']);
});

test('the wire shape is the pair, and the version rides with it', () => {
  const raw = JSON.parse(serializeStore(one('src/a.ts', { x: 40, y: 80 }))) as {
    version: number;
    projects: Record<string, Record<string, Record<string, number[]>>>;
  };
  assert.equal(raw.version, PLACEMENT_VERSION);
  assert.deepEqual(raw.projects[ROOT]?.[key()]?.['src/a.ts'], [40, 80]);
});

test('anything that is not this version is an empty store, not a guess', () => {
  assert.equal(parseStore(null).size, 0);
  assert.equal(parseStore('').size, 0);
  assert.equal(parseStore('{oh no').size, 0);
  assert.equal(parseStore('[]').size, 0);
  assert.equal(parseStore('"a string"').size, 0);
  assert.equal(parseStore(JSON.stringify({ version: PLACEMENT_VERSION + 1, projects: {} })).size, 0);
  assert.equal(parseStore(JSON.stringify({ version: PLACEMENT_VERSION, projects: 7 })).size, 0);
});

test('one unreadable entry costs itself and not the nineteen boxes beside it', () => {
  const raw = JSON.stringify({
    version: PLACEMENT_VERSION,
    projects: {
      [ROOT]: {
        [key()]: {
          good: [10, 20],
          missing: [10],
          wrong: 'over there',
          nan: [null, 3],
          extra: [10, 20, 5000],
        },
      },
    },
  });
  const view = readView(parseStore(raw), ROOT, key());
  assert.deepEqual([...view.keys()], ['good', 'extra']);
  // A width from another version is clamped rather than dropped: the position
  // is still the one somebody chose.
  assert.equal(view.get('extra')?.width, MAX_BOX_WIDTH);
});

test('a store read back over its caps is trimmed on the way in', () => {
  const boxes: Record<string, number[]> = {};
  for (let index = 0; index < MAX_PLACEMENTS + 5; index++) boxes[`box-${index}`] = [index, 0];
  const raw = JSON.stringify({ version: PLACEMENT_VERSION, projects: { [ROOT]: { [key()]: boxes } } });
  assert.equal(readView(parseStore(raw), ROOT, key()).size, MAX_PLACEMENTS);
});

// --- storage -----------------------------------------------------------------

/**
 * A `localStorage` of our own, installed on `globalThis` for one test. The two
 * throwing modes are the two the module's two try/catches are for: a browser
 * that throws from the accessor (a private window, site data blocked) and one
 * that throws from `setItem` (a full quota).
 */
function install(options: { onAccess?: boolean; onWrite?: boolean } = {}): () => void {
  const data = new Map<string, string>();
  const fake: Storage = {
    get length(): number {
      return data.size;
    },
    clear: (): void => data.clear(),
    getItem: (name: string): string | null => data.get(name) ?? null,
    key: (index: number): string | null => [...data.keys()][index] ?? null,
    removeItem: (name: string): void => {
      data.delete(name);
    },
    setItem: (name: string, value: string): void => {
      if (options.onWrite === true) throw new Error('QuotaExceededError');
      data.set(name, value);
    },
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: (): Storage => {
      if (options.onAccess === true) throw new Error('site data is blocked');
      return fake;
    },
  });
  return (): void => {
    if (had === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', had);
  };
}

test('a placement survives a reload, and the two ways back undo it', () => {
  const restore = install();
  try {
    assert.equal(loadPlacements(ROOT, key()).size, 0);

    const after = placeBox(ROOT, key(), 'src/a.ts', { x: 120, y: -40, width: 400 });
    assert.deepEqual(after.get('src/a.ts'), { x: 120, y: -40, width: 400 });
    // A reload is a fresh read of the same storage.
    assert.deepEqual(loadPlacements(ROOT, key()).get('src/a.ts'), { x: 120, y: -40, width: 400 });

    placeBox(ROOT, key(), 'src/b.ts', { x: 0, y: 0 });
    assert.deepEqual([...dropBox(ROOT, key(), 'src/a.ts').keys()], ['src/b.ts']);
    assert.equal(loadPlacements(ROOT, key()).has('src/a.ts'), false);

    assert.equal(dropView(ROOT, key()).size, 0);
    assert.equal(loadPlacements(ROOT, key()).size, 0);
  } finally {
    restore();
  }
});

test('one view arranged does not disturb another, across a reload', () => {
  const restore = install();
  try {
    placeBox(ROOT, key(), 'src/a.ts', { x: 1, y: 1 });
    placeBox(ROOT, key({ scope: 'src/view' }), 'src/view/x.ts', { x: 2, y: 2 });
    placeBox('/other', key(), 'src/a.ts', { x: 3, y: 3 });

    assert.deepEqual(loadPlacements(ROOT, key()).get('src/a.ts'), { x: 1, y: 1 });
    assert.deepEqual(loadPlacements(ROOT, key({ scope: 'src/view' })).get('src/view/x.ts'), { x: 2, y: 2 });
    assert.deepEqual(loadPlacements('/other', key()).get('src/a.ts'), { x: 3, y: 3 });

    dropView(ROOT, key());
    assert.equal(loadPlacements(ROOT, key({ scope: 'src/view' })).size, 1);
    assert.equal(loadPlacements('/other', key()).size, 1);
  } finally {
    restore();
  }
});

test('a browser that blocks site data gets the computed layout and no error', () => {
  const restore = install({ onAccess: true });
  try {
    assert.equal(loadPlacements(ROOT, key()).size, 0);
    // The drag still lands for this session; it is only the reload that forgets.
    assert.deepEqual(placeBox(ROOT, key(), 'src/a.ts', { x: 5, y: 5 }).get('src/a.ts'), { x: 5, y: 5 });
    assert.equal(loadPlacements(ROOT, key()).size, 0);
    assert.equal(dropView(ROOT, key()).size, 0);
  } finally {
    restore();
  }
});

test('a full quota is silent, and the arrangement holds until the reload', () => {
  const restore = install({ onWrite: true });
  try {
    assert.deepEqual(placeBox(ROOT, key(), 'src/a.ts', { x: 5, y: 5 }).get('src/a.ts'), { x: 5, y: 5 });
    assert.equal(loadPlacements(ROOT, key()).size, 0);
  } finally {
    restore();
  }
});

test('a gesture that changed nothing writes nothing', () => {
  const restore = install();
  try {
    placeBox(ROOT, key(), 'src/a.ts', { x: 1, y: 1 });
    const written = globalThis.localStorage.getItem(STORAGE_KEY);
    dropBox(ROOT, key(), 'never-placed.ts');
    dropView(ROOT, key({ scope: 'nothing-here' }));
    placeBox(ROOT, key(), 'src/b.ts', { x: Number.NaN, y: 0 });
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY), written);
  } finally {
    restore();
  }
});

test('a list stores nothing even when the page asks it to', () => {
  const restore = install();
  try {
    const listed = viewKeyOf(spec({ scope: 'src' }), 'list');
    assert.equal(placeBox(ROOT, listed, 'src/a.ts', { x: 1, y: 1 }).size, 0);
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY), null);
  } finally {
    restore();
  }
});
