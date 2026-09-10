// Pure matcher tests: no browser, network, storage, patient records or DB writes.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const matcher = require('../worklist-v0/hpacs-lite/compound-filter.js');
const columns = [
  { k: 'id', t: 'ID', f: 'text' }, { k: 'name', t: 'Name', f: 'text' },
  { k: 'modality', t: 'Modality', f: ['CT', 'MR', 'US'] },
  { k: 'preDoc', t: 'PreDoc', f: 'text' }, { k: 'date', t: 'StudyDate' }, { k: 'count', t: 'Count' },
];
const techColumns = columns.filter(column => column.k !== 'preDoc').concat({ k: 'ward', t: 'Ward', f: 'text' });
const rule = (field, op, value, value2) => ({ field, op, ...(value === undefined ? {} : { value }),
  ...(value2 === undefined ? {} : { value2 }) });
const expr = (rules = [], join = 'and') => ({ version: 1, join, rules });
const match = (study, condition, spec = columns) => matcher.matches(study, condition, spec);
const valid = condition => assert.equal(matcher.validate(condition, columns), null);
function invalid(condition, message = '') {
  assert.equal(typeof matcher.validate(condition, columns), 'string', message);
  assert.equal(match({ id: 'alpha', name: '환자', modality: 'CT', date: '20260909' }, condition), false, message);
}

test('TEST-W-COMPOUND-EXPORT: same pure API in browser and Node, fresh field/operator metadata', () => {
  assert.equal(matcher.KEY, '$compound');
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(join(__dirname, '../worklist-v0/hpacs-lite/compound-filter.js'), 'utf8'), sandbox);
  assert.deepEqual(Object.keys(sandbox.window.KinCompoundFilter), Object.keys(matcher));
  assert.equal(sandbox.window.KinCompoundFilter.matches({ id: 'ALPHA' }, expr([rule('id', 'eq', 'alpha')]), columns), true);
  assert.deepEqual(matcher.fields(columns).map(field => [field.k, field.type]),
    [['id', 'text'], ['name', 'text'], ['modality', 'select'], ['preDoc', 'text'], ['date', 'date']]);
  assert.equal(matcher.fields([])[0].k, 'date');
  assert.deepEqual(matcher.fields(null), []);
  const fields = matcher.fields(columns);
  fields.find(field => field.k === 'modality').values.push('BAD');
  assert.deepEqual(columns[2].f, ['CT', 'MR', 'US']);
  const ops = matcher.operators(fields[0]);
  ops[0][0] = 'BAD';
  assert.equal(matcher.operators(fields[0])[0][0], 'contains');
  assert.deepEqual(matcher.operators({ type: 'unknown' }), []);
  assert.deepEqual(matcher.operators({ type: 'constructor' }), []);
  assert.deepEqual(matcher.operators({ type: '__proto__' }), []);
  assert.deepEqual(matcher.operators(null), []);
});

test('TEST-W-COMPOUND-LEGACY: absent condition and explicit empty rules preserve unfiltered behavior', () => {
  assert.equal(matcher.validate(undefined, columns), null);
  assert.equal(match({}, undefined), true);
  for (const join of ['and', 'or']) {
    valid(expr([], join));
    assert.equal(match({}, expr([], join)), true);
  }
  invalid(null);
  invalid(false);
  invalid('');
});

test('TEST-W-COMPOUND-BOOLEAN: all/any conditions and case-insensitive select values', () => {
  const study = { id: 'SYN-ALPHA', name: '환자 갑', modality: 'CT' };
  const rules = [rule('id', 'contains', 'alpha'), rule('modality', 'eq', 'mr')];
  valid(expr(rules));
  assert.equal(match(study, expr(rules)), false);
  assert.equal(match(study, expr(rules, 'or')), true);
  assert.equal(match(study, expr([rule('id', 'eq', 'syn-alpha'), rule('modality', 'eq', 'ct')])), true);
  assert.equal(match(study, expr([rule('modality', 'neq', 'MR')])), true);
  assert.equal(match(study, expr([rule('modality', 'neq', 'ct')])), false);
  invalid(expr([rule('modality', 'eq', 'PT')]));
  invalid(expr([rule('modality', 'contains', 'CT')]));
});

test('TEST-W-COMPOUND-TEXT: literal Unicode, wildcard and markup values do not execute or become regex', () => {
  for (const literal of ['환자', 'ÉTÉ', '.*', '[ab]', '%_', '<img src=x onerror=alert(1)>', '${globalThis.compromised=true}']) {
    const condition = expr([rule('name', 'contains', literal)]);
    valid(condition);
    assert.equal(match({ name: `prefix ${literal.toLowerCase()} suffix` }, condition), true, literal);
    assert.equal(match({ name: 'unrelated abc' }, condition), false, literal);
    assert.equal(match({ name: 'unrelated abc' }, expr([rule('name', 'notContains', literal)])), true, literal);
  }
  assert.equal(globalThis.compromised, undefined);
  assert.equal(match({ name: ' x ' }, expr([rule('name', 'eq', ' x ')])), true);
  assert.equal(match({ name: 'x' }, expr([rule('name', 'eq', ' x ')])), false);
});

test('TEST-W-COMPOUND-EMPTY: negative comparisons exclude absent values and blanks are explicit', () => {
  for (const name of [undefined, null, '']) {
    for (const op of ['eq', 'contains', 'neq', 'notContains']) {
      assert.equal(match({ name }, expr([rule('name', op, 'x')])), false, `${name}/${op}`);
    }
    assert.equal(match({ name }, expr([rule('name', 'empty')])), true);
    assert.equal(match({ name }, expr([rule('name', 'notEmpty')])), false);
  }
  assert.equal(match({}, expr([rule('name', 'empty')])), true);
  assert.equal(match({ name: ' ' }, expr([rule('name', 'empty')])), false);
  assert.equal(match({ name: ' ' }, expr([rule('name', 'notEmpty')])), true);
  assert.equal(match({ name: 'y' }, expr([rule('name', 'neq', 'x')])), true);
  for (const name of [0, false, [], {}, ['x']]) {
    assert.equal(match({ name }, expr([rule('name', 'neq', 'x')])), false);
  }
  assert.equal(match(Object.create({ name: 'x' }), expr([rule('name', 'eq', 'x')])), false);
  assert.equal(match(null, expr([rule('name', 'empty')])), false);
});

test('TEST-W-COMPOUND-SINGLE-LINE: stored CR/LF criteria fail closed before input sanitization', () => {
  for (const value of ['A\nB', 'A\rB', 'A\r\nB', '\nAB', 'AB\r']) {
    for (const op of ['contains', 'eq', 'notContains', 'neq', 'empty', 'notEmpty']) {
      const condition = expr([rule('name', op, value)]);
      invalid(condition, `${op}/${JSON.stringify(value)}`);
      assert.equal(match({ name: 'AB' }, condition), false);
      assert.equal(match({ name: value }, condition), false);
    }
    invalid(expr([rule('id', 'eq', 'alpha'), rule('name', 'eq', value)], 'or'));
  }
  invalid(expr([rule('modality', 'eq', 'C\nT')]));
  invalid(expr([rule('date', 'eq', '2026-09-09\r')]));
  invalid(expr([rule('date', 'between', '2026-09-01', '2026-09-09\n')]));
  // The restriction is on the query, not source text; a single-line literal can
  // still locate text inside a multiline description without rewriting it.
  valid(expr([rule('name', 'contains', 'alpha')]));
  assert.equal(match({ name: 'prefix\nALPHA\nsuffix' }, expr([rule('name', 'contains', 'alpha')])), true);
});

test('TEST-W-COMPOUND-DATE: calendar comparisons are inclusive and accept source date prefixes', () => {
  for (const date of ['20260909', '2026-09-09', '20260909 120000', '2026-09-09T12:00:00+09:00']) {
    for (const op of ['eq', 'gte', 'lte']) {
      assert.equal(match({ date }, expr([rule('date', op, '2026-09-09')])), true, `${date}/${op}`);
    }
    assert.equal(match({ date }, expr([rule('date', 'neq', '2026-09-09')])), false);
  }
  const period = expr([rule('date', 'between', '2026-09-01', '2026-09-09')]);
  for (const date of ['20260901', '20260905', '20260909']) assert.equal(match({ date }, period), true);
  for (const date of ['20260831', '20260910']) assert.equal(match({ date }, period), false);
  assert.equal(match({ date: '20260910' }, expr([rule('date', 'neq', '2026-09-09')])), true);
  assert.equal(match({ date: '20260908' }, expr([rule('date', 'gte', '2026-09-09')])), false);
  assert.equal(match({ date: '20260910' }, expr([rule('date', 'lte', '2026-09-09')])), false);
  assert.equal(match({ date: '20260909' }, expr([rule('date', 'between', '2026-09-09', '2026-09-09')])), true);
});

test('TEST-W-COMPOUND-DATE-VALIDITY: leap years and invalid dates never match even negative comparisons', () => {
  for (const date of ['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '2026-04-30', '9999-12-31']) {
    valid(expr([rule('date', 'eq', date)]));
    assert.equal(match({ date }, expr([rule('date', 'eq', date)])), true);
  }
  for (const date of ['0000-01-01', '1900-02-29', '2100-02-29', '2026-02-29', '2026-04-31',
    '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-9-09', '2026-09-9', 'bad']) {
    invalid(expr([rule('date', 'eq', date)]), date);
    for (const source of [date, date.replaceAll('-', '')]) {
      for (const op of ['eq', 'neq', 'gte', 'lte', 'between']) {
        assert.equal(match({ date: source }, expr([rule('date', op, '2026-09-09', '2026-09-10')])), false, `${source}/${op}`);
      }
    }
  }
  for (const date of [undefined, null, '', 20260909, {}, [], ' 2026-09-09']) {
    assert.equal(match({ date }, expr([rule('date', 'neq', '2026-09-09')])), false);
  }
  for (const date of ['20260909', '2026-09-09\n', '2026-09-09T00:00:00Z', ' 2026-09-09']) {
    invalid(expr([rule('date', 'eq', date)]), date);
  }
  invalid(expr([rule('date', 'between', '2026-09-10', '2026-09-09')]));
  invalid(expr([rule('date', 'between', '2026-09-09')]));
  invalid(expr([rule('date', 'between', '2026-09-09', '2026-02-30')]));
});

test('TEST-W-COMPOUND-SCHEMA: unsupported versions, operators, mode fields and malformed rules fail closed', () => {
  for (const condition of [[], {}, { version: 2, join: 'and', rules: [] }, { version: '1', join: 'and', rules: [] },
    { version: 1, join: 'AND', rules: [] }, { version: 1, join: 'or', rules: {} },
    { ...expr(), futureBehavior: true }, expr([null]), expr([[]]), expr([{}]),
    expr([rule('count', 'eq', '1')]), expr([rule('constructor', 'eq', 'x')]),
    expr([rule('id', 'regex', '.*')]), expr([{ ...rule('id', 'eq', 'alpha'), negate: true }]),
    expr([rule('id', 'contains', 'alpha'), rule('id', 'regex', '.*')], 'or')]) invalid(condition);
  invalid(Object.create(expr()));
  invalid(expr([Object.create(rule('id', 'eq', 'alpha'))]));
  invalid(expr([Object.assign(Object.create({ value: 'alpha' }), { field: 'id', op: 'eq' })]));
  const modeCondition = expr([rule('preDoc', 'eq', 'Reader')]);
  valid(modeCondition);
  assert.equal(match({ preDoc: 'Reader' }, modeCondition), true);
  assert.equal(typeof matcher.validate(modeCondition, techColumns), 'string');
  assert.equal(match({ preDoc: 'Reader' }, modeCondition, techColumns), false);
  assert.equal(matcher.validate(expr([rule('ward', 'eq', 'W1')]), techColumns), null);
  assert.equal(match({ ward: 'W1' }, expr([rule('ward', 'eq', 'W1')]), techColumns), true);
  assert.equal(match({}, expr(), null), false);
});

test('TEST-W-COMPOUND-LIMITS: twenty rules and 1,000 characters allowed without mutating callers', () => {
  const condition = expr(Array.from({ length: 20 }, () => rule('id', 'eq', 'x'.repeat(1000))));
  const study = { id: 'x'.repeat(1000) };
  const before = JSON.stringify({ condition, study, columns });
  valid(condition);
  assert.equal(match(study, condition), true);
  assert.equal(JSON.stringify({ condition, study, columns }), before);
  invalid(expr(Array.from({ length: 21 }, () => rule('id', 'eq', 'x'))));
  for (const value of ['', ' \t\n', null, false, 0, [], {}, 'x'.repeat(1001)]) {
    invalid(expr([rule('id', 'eq', value)]));
  }
});

test('TEST-D01-NESTED: groups preserve parentheses and validate even unmatched branches',()=>{
  const group=(rules,join='or')=>({join,rules});
  const condition=expr([group([rule('modality','eq','CT'),rule('modality','eq','MR')]),group([rule('name','contains','A'),rule('id','eq','B')])]);
  valid(condition);
  for(const [study,wanted] of [[{modality:'CT',name:'A'},true],[{modality:'MR',id:'B'},true],[{modality:'CT',id:'C'},false],[{modality:'US',name:'A'},false]])assert.equal(match(study,condition),wanted);
  assert.equal(matcher.describe(condition,columns),'((Modality 같음 CT OR Modality 같음 MR) AND (Name 포함 A OR ID 같음 B))');
  for(const node of [group([]),group([rule('id','regex','.*')]),{join:'or',rules:[rule('id','eq','alpha')],extra:true}])invalid(expr([rule('id','eq','alpha'),node],'or'));
  let deep=rule('id','eq','alpha');for(let i=0;i<5;i++)deep=group([deep]);valid(expr([deep]));invalid(expr([group([deep])]));
  invalid(expr([group(Array.from({length:21},()=>rule('id','eq','alpha')))]));
  const forty=expr(Array.from({length:20},()=>group([rule('id','eq','alpha')])));valid(forty);
  forty.rules[0]=group([forty.rules[0]]);invalid(forty);
  const cycle=group([]);cycle.rules.push(cycle);invalid(expr([cycle]));
  const compiled=matcher.compile(condition,columns);condition.rules[0].rules[0].value='US';
  assert.equal(compiled({modality:'CT',name:'A'}),true);assert.equal(match({modality:'CT',name:'A'},condition),false);
});


test('TEST-QUICK-MATCH: literal case-insensitive separate fields, blank and all three modes', () => {
  const rows = [{id:'ABC'}, {id:'ABCD'}, {id:'XABC'}, {id:'NO',name:'abc'}, {id:'A',name:'BC'}];
  for (const [mode, expected] of [['contains',[0,1,2,3]], ['prefix',[0,1,3]], ['exact',[0,3]]]) {
    const expression = matcher.withQuickMode(undefined, mode, columns);
    assert.deepEqual(rows.map((row,i) => matcher.compileQuick(' abc ',expression,columns)(row) ? i : -1).filter(i=>i>=0),expected);
    assert.ok(rows.every(matcher.compileQuick('  ',expression,columns)));
    assert.equal(matcher.compileQuick('.*',expression,columns)({id:'anything'}),false);
    assert.equal(matcher.compileQuick('.*',expression,columns)({id:'.*'}),true);
  }
});

test('TEST-QUICK-MATCH: versioned criteria preserve nested rules and downgrade explicitly', () => {
  const original=expr([{join:'or',rules:[rule('modality','eq','CT'),rule('modality','eq','MR')]}]);
  const saved=JSON.stringify(original), exact=matcher.withQuickMode(original,'exact',columns);
  assert.equal(exact.version,2); assert.equal(exact.quickMatch,'exact'); valid(exact);
  assert.equal(JSON.stringify(original),saved);
  assert.deepEqual(matcher.withQuickMode(exact,'contains',columns),original);
  const quick=matcher.compileQuick('abc',exact,columns), detail=matcher.compile(exact,columns);
  assert.equal(quick({id:'abc',modality:'CT'})&&detail({id:'abc',modality:'CT'}),true);
  assert.equal(quick({id:'abcd',modality:'CT'})&&detail({id:'abcd',modality:'CT'}),false);
  assert.equal(quick({id:'abc',modality:'US'})&&detail({id:'abc',modality:'US'}),false);
  assert.equal(matcher.withQuickMode(matcher.withQuickMode(undefined,'prefix',columns),'contains',columns),undefined);
  // Freeze the previously shipped validator: it must reject version 2, not broaden it.
  const oldRootAccepts = root => root.version === 1 && Object.keys(root).every(key=>['version','join','rules'].includes(key));
  assert.equal(oldRootAccepts(original),true);
  assert.equal(oldRootAccepts(exact),false);
});

test('TEST-QUICK-MATCH: corrupt modes fail closed even for blank input and cannot normalize', () => {
  for(const expression of [null, {...expr(),version:2}, {...expr(),version:2,quickMatch:'contains'},
    {...expr(),version:2,quickMatch:'wildcard'}, {...expr(),quickMatch:'exact'},
    {...expr(),version:2,quickMatch:'exact',extra:true}, {...expr(),version:3,quickMatch:'exact'}]) {
    invalid(expression);
    assert.equal(matcher.compileQuick('',expression,columns)({id:'abc'}),false);
    assert.throws(()=>matcher.withQuickMode(expression,'contains',columns));
  }
});
