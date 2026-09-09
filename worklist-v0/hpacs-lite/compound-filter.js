(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinCompoundFilter = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  const KEY = '$compound';
  const OPS = {
    text: [['contains', '포함'], ['eq', '같음'], ['notContains', '포함하지 않음'],
      ['neq', '같지 않음'], ['empty', '비어 있음'], ['notEmpty', '값 있음']],
    select: [['eq', '같음'], ['neq', '같지 않음'], ['empty', '비어 있음'], ['notEmpty', '값 있음']],
    date: [['eq', '같은 날'], ['neq', '다른 날'], ['gte', '이후 (포함)'], ['lte', '이전 (포함)'],
      ['between', '기간 (양 끝 포함)'], ['empty', '비어 있음'], ['notEmpty', '값 있음']],
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const blank = value => value === undefined || value === null || value === '';

  function fields(columns) {
    if (!Array.isArray(columns)) return [];
    const result = [], seen = new Set();
    for (const column of columns) {
      if (!record(column) || typeof column.k !== 'string' || !column.k || seen.has(column.k)) continue;
      let field;
      if (column.k === 'date') field = { k: 'date', t: column.t || '검사일', type: 'date' };
      else if (column.f === 'text') field = { k: column.k, t: column.t || column.k, type: 'text' };
      else if (Array.isArray(column.f) && column.f.every(value => typeof value === 'string')) {
        field = { k: column.k, t: column.t || column.k, type: 'select', values: [...column.f] };
      }
      if (field) { result.push(field); seen.add(column.k); }
    }
    if (!seen.has('date')) result.push({ k: 'date', t: '검사일', type: 'date' });
    return result;
  }

  function operators(field) {
    return (own(OPS, field?.type) ? OPS[field.type] : []).map(pair => [...pair]);
  }

  function calendarDate(value, exact) {
    if (typeof value !== 'string' || (exact && value.length !== 10)) return null;
    const parts = exact ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      : /^(\d{4})-(\d{2})-(\d{2})/.exec(value) || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!parts) return null;
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
    // Calendar integers avoid timezone/DST shifts and Date's year 0–99 coercion.
    return year * 10000 + month * 100 + day;
  }

  function validate(expression, columns) {
    if (expression === undefined) return null;
    if (!record(expression) || !['version', 'join', 'rules'].every(key => own(expression, key))
      || Object.keys(expression).some(key => !['version', 'join', 'rules'].includes(key))
      || expression.version !== 1 || !['and', 'or'].includes(expression.join)) {
      return '지원하지 않거나 손상된 복합 검색 조건입니다. 조건을 다시 설정해 주세요.';
    }
    if (!Array.isArray(expression.rules) || expression.rules.length > 20) {
      return '복합 검색 조건은 최대 20개까지 사용할 수 있습니다.';
    }
    if (!Array.isArray(columns)) return '검색 모드의 열 정보를 확인할 수 없습니다.';
    const available = new Map(fields(columns).map(field => [field.k, field]));
    let nodes = 0, leaves = 0;
    function visit(group, depth) {
      if (depth > 5 || !record(group) || !['and','or'].includes(group.join)
        || !Array.isArray(group.rules) || (depth > 0 && (!group.rules.length
          || Object.keys(group).sort().join() !== 'join,rules'))) return '조건 그룹은 비어 있을 수 없으며 최대 5단계까지 중첩할 수 있습니다.';
      for (const rule of group.rules) {
        if (++nodes > 40) return '복합 검색 항목과 그룹은 합계 40개까지 사용할 수 있습니다.';
        if (record(rule) && own(rule, 'rules')) {
          const error = visit(rule, depth + 1); if (error) return error;
          continue;
        }
        if (++leaves > 20) return '복합 검색 조건은 전체 그룹 합계 20개까지 사용할 수 있습니다.';
      if (!record(rule) || !own(rule, 'field') || !own(rule, 'op')
        || Object.keys(rule).some(key => !['field', 'op', 'value', 'value2'].includes(key))) {
        return '손상된 검색 조건이 있습니다. 해당 조건을 다시 설정해 주세요.';
      }
      const field = available.get(rule.field);
      if (!field) return '현재 모드에서 사용할 수 없는 검색 항목입니다.';
      if (!operators(field).some(([op]) => op === rule.op)) return '검색 항목에 사용할 수 없는 비교 방법입니다.';
      // Single-line controls strip CR/LF on assignment. Reject stored multiline
      // criteria before the editor can silently change their matching meaning.
      if (['value', 'value2'].some(key => typeof rule[key] === 'string' && /[\r\n]/.test(rule[key]))) {
        return '검색 값에는 줄바꿈을 사용할 수 없습니다.';
      }
      if (rule.op === 'empty' || rule.op === 'notEmpty') continue;
      if (!own(rule, 'value') || typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 1000) {
        return '검색 값은 공백이 아닌 1~1,000자 문자열이어야 합니다.';
      }
      if (field.type === 'select' && !field.values.some(value => value.toUpperCase() === rule.value.toUpperCase())) {
        return '검색 항목에서 선택할 수 없는 값입니다.';
      }
      if (field.type === 'date') {
        const first = calendarDate(rule.value, true);
        if (first === null) return '검사일은 실제 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.';
        if (rule.op === 'between') {
          const last = own(rule, 'value2') ? calendarDate(rule.value2, true) : null;
          if (last === null) return '종료일은 실제 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.';
          if (first > last) return '시작일은 종료일보다 늦을 수 없습니다.';
        }
      }
      }
      return null;
    }
    return visit(expression, 0);
  }

  function matches(study, expression, columns) {
    return compile(expression, columns)(study);
  }

  function compile(expression, columns) {
    if (expression === undefined) return () => true;
    // Validate all branches once before any short circuit can broaden results.
    if (validate(expression, columns) !== null) return () => false;
    expression = JSON.parse(JSON.stringify(expression));
    if (!expression.rules.length) return () => true;
    const available = new Map(fields(columns).map(field => [field.k, field]));
    function matchRule(study, rule) {
      const value = own(study, rule.field) ? study[rule.field] : undefined;
      if (rule.op === 'empty') return blank(value);
      if (rule.op === 'notEmpty') return !blank(value);
      // Missing values are not unequal values; use the explicit empty operator.
      if (blank(value) || typeof value !== 'string') return false;
      if (available.get(rule.field).type === 'date') {
        const actual = calendarDate(value, false), wanted = calendarDate(rule.value, true);
        if (actual === null) return false;
        switch (rule.op) {
          case 'eq': return actual === wanted;
          case 'neq': return actual !== wanted;
          case 'gte': return actual >= wanted;
          case 'lte': return actual <= wanted;
          case 'between': return actual >= wanted && actual <= calendarDate(rule.value2, true);
          default: return false;
        }
      }
      const actual = value.toUpperCase(), wanted = rule.value.toUpperCase();
      switch (rule.op) {
        case 'eq': return actual === wanted;
        case 'neq': return actual !== wanted;
        case 'contains': return actual.includes(wanted);
        case 'notContains': return !actual.includes(wanted);
        default: return false;
      }
    }
    function groupMatch(study, group) {
      const match = node => own(node, 'rules') ? groupMatch(study, node) : matchRule(study, node);
      return group.join === 'and' ? group.rules.every(match) : group.rules.some(match);
    }
    return study => record(study) && groupMatch(study, expression);
  }

  function describe(expression, columns) {
    if (validate(expression, columns)) return '복합 조건 오류';
    if (!expression?.rules.length) return '';
    const available = new Map(fields(columns).map(field => [field.k, field]));
    function groupText(group) {
      return '(' + group.rules.map(rule => {
        if (own(rule, 'rules')) return groupText(rule);
        const field = available.get(rule.field), op = operators(field).find(([op]) => op === rule.op)[1];
        return `${field.t} ${op}${['empty','notEmpty'].includes(rule.op) ? '' : ' ' + rule.value}${rule.op === 'between' ? ' ~ ' + rule.value2 : ''}`;
      }).join(group.join === 'or' ? ' OR ' : ' AND ') + ')';
    }
    return groupText(expression);
  }
  return { KEY, fields, operators, validate, matches, compile, describe };
});
