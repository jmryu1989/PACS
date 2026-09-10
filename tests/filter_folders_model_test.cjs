const { test } = require('node:test');
const assert = require('node:assert/strict');
const { folderPath, folderEntries, folderAction } = require('/app/dist/filter-folders.js');
const status = code => error => error.getStatus?.() === code;
const entry = (path, description = '', ordinal = 0) => ({ path, description, ordinal });

test('folder paths and metadata are bounded and literal', () => {
  assert.equal(folderPath(' A / B '), 'A/B');
  assert.equal(folderPath('', true), '');
  assert.equal(folderPath('A%/_/constructor'), 'A%/_/constructor');
  for (const path of ['', 'A//B', 'A/../B', 'A\\B', 'A\nB', 'x'.repeat(41), 'A/B/C/D/E/F'])
    assert.throws(() => folderPath(path), status(400));
  assert.throws(() => folderEntries([entry('A'), entry('A')]), status(400));
  assert.throws(() => folderEntries([{ ...entry('A'), owner: 'other' }]), status(400));
  assert.throws(() => folderEntries([entry('A', 'x'.repeat(1001))]), status(400));
  assert.throws(() => folderEntries([entry('A', '', 0.5)]), status(400));
});

test('empty folders and ancestors persist without creating searches', () => {
  const result = folderAction([], [], { action: 'save-folder', path: 'A/B', description: '<img>', ordinal: 7 });
  assert.deepEqual(result.folders, [entry('A'), entry('A/B', '<img>', 7)]);
  assert.deepEqual(result.moves, []); assert.deepEqual(result.deletes, []);
  const updated = folderAction(result.folders, [], { action: 'save-folder', path: 'A/B', description: 'kept', ordinal: 2 });
  assert.deepEqual(updated.folders[1], entry('A/B', 'kept', 2));
  assert.equal(result.folders[1].description, '<img>');
});

test('subtree moves preserve metadata and never interpret SQL wildcard characters', () => {
  const folders = [entry('A%', 'root', 9), entry('A%/_', 'child', 3)];
  const searches = [{ id: 1, folder: 'A%/_', name: 'same', cols: { desc: 'CT' } }, { id: 2, folder: 'Axy/_' }];
  const before = JSON.stringify({ folders, searches });
  const result = folderAction(folders, searches, { action: 'move-folder', from: 'A%', to: 'Z' });
  assert.deepEqual(result.moves, [{ id: 1, folder: 'Z/_' }]);
  assert.deepEqual(result.folders, [entry('Z', 'root', 9), entry('Z/_', 'child', 3)]);
  assert.equal(JSON.stringify({ folders, searches }), before);
  assert.throws(() => folderAction(folders, searches, { action: 'move-folder', from: 'A%', to: 'A%/inside' }), status(400));
  assert.throws(() => folderAction(folders, searches, { action: 'move-folder', from: 'A%', to: 'Axy' }), status(409));
  assert.throws(() => folderAction([], [{ id: 1, folder: 'A/B/C/D/E' }], { action: 'move-folder', from: 'A', to: 'X/Y' }), status(400));
});

test('removing a folder retains all contained searches in its parent', () => {
  const folders = [entry('A'), entry('A/B'), entry('A/B/C'), entry('A/Beta')];
  const searches = [{ id: 1, folder: 'A/B/C' }, { id: 2, folder: 'A/B' }, { id: 3, folder: 'A/Beta' }];
  const result = folderAction(folders, searches, { action: 'remove-folder', path: 'A/B' });
  assert.deepEqual(result.moves, [{ id: 1, folder: 'A' }, { id: 2, folder: 'A' }]);
  assert.deepEqual(result.deletes, []); assert.deepEqual(result.folders, [entry('A'), entry('A/Beta')]);
});

test('bulk commands require exact owned IDs and never silently skip missing searches', () => {
  const searches = [{ id: 1, folder: '' }, { id: 2, folder: 'A' }];
  assert.deepEqual(folderAction([], searches, { action: 'move-searches', ids: [1], to: 'New/Empty' }).moves, [{ id: 1, folder: 'New/Empty' }]);
  assert.deepEqual(folderAction([], searches, { action: 'delete-searches', ids: [2] }).deletes, [2]);
  for (const ids of [[], [1, 1], [0], ['1'], Array.from({ length: 201 }, (_, i) => i + 1)])
    assert.throws(() => folderAction([], searches, { action: 'delete-searches', ids }), status(400));
  assert.throws(() => folderAction([], searches, { action: 'delete-searches', ids: [1, 3] }), status(404));
  assert.throws(() => folderAction([], searches, { action: 'delete-searches', ids: [1], force: true }), status(400));
  assert.throws(() => folderAction(Array.from({ length: 200 }, (_, i) => entry('F' + i)), searches,
    { action: 'save-folder', path: 'overflow', description: '', ordinal: 0 }), status(400));
});
