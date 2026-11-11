// FB-064: the Studies panel lists a study's series by Series Number (then series date and time) on every opening.
// The shipped config/ohif/series-order.js runs against a display set service with the pinned OHIF 3.9.1 behaviour:
// display sets are appended in the order their metadata arrives, DISPLAY_SETS_ADDED follows, and sortDisplaySets
// sorts the same array in place and broadcasts DISPLAY_SETS_CHANGED (the event the stock Studies panel redraws on).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('config/ohif/series-order.js', 'utf8'), context, { filename: 'series-order.js' });
  return context;
}
function service() {
  const listeners = new Map(), events = [];
  const s = { EVENTS: { DISPLAY_SETS_ADDED: 'added', DISPLAY_SETS_CHANGED: 'changed' }, activeDisplaySets: [], events,
    getActiveDisplaySets() { return this.activeDisplaySets; },
    subscribe(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn);
      return { unsubscribe: () => listeners.get(event).delete(fn) }; },
    broadcast(event, data) { events.push(event); for (const fn of [...(listeners.get(event) || [])]) fn(data); },
    // As the pinned service: append, CHANGED, then ADDED.
    add(...sets) { this.activeDisplaySets.push(...sets); this.broadcast('changed', this.activeDisplaySets); this.broadcast('added', { displaySetsAdded: sets }); },
    sortDisplaySets(fn, direction, suppressEvent = false) {
      this.activeDisplaySets.sort(fn); if (direction === 'descending') this.activeDisplaySets.reverse();
      if (!suppressEvent) this.broadcast('changed', this.activeDisplaySets);
    },
    listeners: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
  return s;
}
const ds = (id, SeriesNumber, extra = {}) => ({ displaySetInstanceUID: id, SeriesInstanceUID: 'S-' + id, SeriesNumber, SeriesDate: '20261111', SeriesTime: '081500', ...extra });
const ids = s => s.activeDisplaySets.map(set => set.displaySetInstanceUID);

test('series arriving out of order are listed by Series Number, after every arrival', () => {
  const { kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  // The opening seen on the served viewer: T1 (1), DWI (4), T2 (2), FLAIR (3).
  s.add(ds('T1', 1)); s.add(ds('DWI', 4));
  assert.deepEqual(ids(s), ['T1', 'DWI']);
  s.add(ds('T2', 2));
  assert.deepEqual(ids(s), ['T1', 'T2', 'DWI']);
  s.add(ds('FLAIR', 3));
  assert.deepEqual(ids(s), ['T1', 'T2', 'FLAIR', 'DWI']);
  // The sort's own change event is what the stock panel redraws on; an arrival already in order adds none.
  assert.equal(s.events.filter(e => e === 'changed').length, 4 + 2);
  s.add(ds('ADC', 5));
  assert.equal(s.events.filter(e => e === 'changed').length, 5 + 2);
  extension.onModeExit();
  assert.equal(s.listeners(), 0);
});

test('the same arrivals in any order give one list', () => {
  const { kinCreateSeriesOrder } = load();
  const sets = () => [ds('a', 3), ds('b', '10'), ds('c', 2), ds('d', 1)];
  const seen = new Set();
  for (const arrival of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    const s = service(), extension = kinCreateSeriesOrder(), all = sets();
    extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
    for (const index of arrival) s.add(all[index]);
    seen.add(ids(s).join(','));
    extension.onModeExit();
  }
  assert.deepEqual([...seen], ['d,c,a,b'], 'numbers compare as numbers (10 after 3)');
});

test('equal numbers follow series date and time; a missing number or date goes last; split parts keep their order', () => {
  const { kinSeriesOrder, kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  // Already present before the mode starts: sorted at once.
  s.activeDisplaySets.push(ds('none', undefined), ds('late', 2, { SeriesTime: '090000' }), ds('nodate', 2, { SeriesDate: '' }),
    ds('early', 2, { SeriesTime: '080000' }), ds('blank', ' '));
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  assert.deepEqual(ids(s).slice(0, 3), ['early', 'late', 'nodate']);
  assert.deepEqual(ids(s).slice(3).sort(), ['blank', 'none']);
  // Two parts of one split series (same series, number and time) stay in the order the split made them.
  const part = (id, k) => ({ ...ds(id, 7), SeriesInstanceUID: 'S-split', SeriesDescription: 'DWI · ' + k + '/2' });
  s.add(part('split-2', 2), ds('six', 6));
  s.add(part('split-1', 1));
  assert.deepEqual(ids(s).slice(0, 6), ['early', 'late', 'nodate', 'six', 'split-2', 'split-1']);
  assert.deepEqual(ids(s).slice(6).sort(), ['blank', 'none']);
  assert.equal(kinSeriesOrder(part('x', 1), part('y', 2)), 0);
  extension.onModeExit();
});

test('a service without sortDisplaySets is left as it is', () => {
  const { kinCreateSeriesOrder } = load(), s = service();
  delete s.sortDisplaySets; s.sortDisplaySets = undefined;
  const extension = kinCreateSeriesOrder();
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  s.add(ds('b', 2), ds('a', 1));
  assert.deepEqual(ids(s), ['b', 'a']);
  assert.equal(s.listeners(), 0);
});
