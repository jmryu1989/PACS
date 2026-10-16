'use strict';
/*
 * The raw-client/receiver flow proof of the audit completeness check (tests/admin_audit_attribution_test.cjs).
 *
 * EMR-D round 5 part (a), a5: Astra D114 consult R5A2-SQL, decision (1) (evidence/ux-stage-inputs/astra-codesign/
 * consult-emr-d-r5a-closure-20261013/report.md section 1). SPEC-F01/W1-W6/F02 -> RISK: a real writer missed or a wrong
 * non-audit verdict (R5A2-SQL) -> TEST: the existing corpus of the check and RF-P/H/C/R/S/A
 * (tests/fixtures/admin-audit-checker/raw-flow/cases.json).
 *
 * Why a module of its own: the action proof (W3/W4/W3-C) deliberately refuses a closed factory, a mutable or public
 * holder and an interface-typed receiver (CW12, CW18 X01-factory). Widening those rules would revise the trust boundary
 * of audit actions. What the raw SQL and client rules need is narrower - where a Prisma client or an instance of a
 * program class actually goes, and which code an interface call actually runs - and it is proved here, separately, on
 * the Program and TypeChecker the check already built (no parser of its own, no product path, class or function name).
 *
 * Three questions, each answered with a witness or refused with where and why:
 *  - consumers (`closure`): every place a tracked value reaches from where it is put - a local, a parameter of every
 *    callee the flow reading fixes, a module binding, a return to every call of its function, a field of a program class
 *    whose instances keep to W4 (raw purpose), an object literal slot, followed along its property path through every
 *    alias, argument, return, destructuring and spread - and every use there: a member read or call by a key W1 fixes,
 *    a test, or one of these edges. Anything else (a key the program does not fix, a library or opaque consumer, an
 *    array, a call of the value, a write through an alias the W4 check does not type, an extracted method) refuses.
 *  - producers (`targetsOf`): the concrete classes an interface-typed receiver can be - `new` of a program class, a
 *    binding's initializer and every write, a parameter's argument at every call, a function's every return - with an
 *    empty or unfollowed producer set refused; the member called must be a method with a body nothing replaces, of a
 *    class whose instances keep to W4 (raw purpose).
 *  - callback slots (`callbackSlot`): a field called with its holder as `this` holds only functions that cannot observe
 *    `this` (arrow functions, or function code without its own `this`), from its initializer and every write, through
 *    parameters at every call of their method or function.
 * The graph is explored completely before a verdict: a value met again on a path already explored adds nothing, an
 * unexplored edge is never taken as safe, and exceeding the exploration limit is a refusal. Exploration order does not
 * change a verdict (RF-R).
 *
 * The certificate (purpose `raw-client-receiver`) is consumed by the client flow, by flow-mode call resolution and by
 * F02's receiver escape only. It is never an action value, an action literal set, a prefix, a writer list or a W5
 * grammar input; SQL text, fragment provenance and primitive parameters still pass the existing rules (RF-S, RF-A).
 */

const PURPOSE = 'raw-client-receiver';
const NODE_LIMIT = 8000, PATH_LIMIT = 4, PRODUCER_DEPTH = 80;

/**
 * `api` is the audit check's own reading of one Program: the TypeScript module, its TypeChecker, the W1 key and
 * reference helpers, and the flow-mode call resolution and W4 raw-purpose verdicts (memoized there, by purpose).
 */
function buildRawFlow(api) {
  const { ts, checker } = api, K = ts.SyntaxKind;
  const CHOICES = new Set([K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken]);
  const certificate = [];
  const at = node => `${api.where(node)} (\`${api.snippet(node)}\`)`;

  /** The expression whose parent is the use of `node`'s value: notation and the operators that pass a value on. */
  function climb(node) {
    let current = node;
    for (;;) {
      const parent = current.parent;
      if (!parent) return current;
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)
        || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isAwaitExpression(parent)
        || (ts.isConditionalExpression(parent) && parent.condition !== current)
        || (ts.isBinaryExpression(parent) && CHOICES.has(parent.operatorToken.kind))
        || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === K.CommaToken && parent.right === current)) { current = parent; continue; }
      return current;
    }
  }
  const keyOf = name => (name ? api.w1(name).key : undefined);
  const describe = owner => api.describe(owner);

  /** The non-static members named `key` of a class family. */
  function familyMembers(family, key) {
    return family.flatMap(declaration => declaration.members.filter(member => member.name && !ts.isComputedPropertyName(member.name)
      && member.name.text === key && !api.isStatic(member)));
  }
  /** Why the member `key` of a class family is not code the program has and nothing replaces, else null. */
  function methodIssue(family, key) {
    const members = familyMembers(family, key);
    if (!members.length) return `no member \`${key}\` in \`${family.map(api.className).join(', ')}\``;
    for (const member of members) {
      if (!(ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) || !member.body || !api.inProgram(member))
        return `\`${key}\` of \`${api.className(member.parent)}\` is not a method with a body in the program (${ts.SyntaxKind[member.kind]})`;
      // A decorated method may run another body than the one declared (named limits L5/L7 are about metadata only).
      if (api.decorated(member) || member.parameters.some(api.decorated)) return `\`${key}\` of \`${api.className(member.parent)}\` is decorated`;
      const replaced = api.memberChanged(api.symbolAt(member.name));
      if (replaced) return `\`${key}\` of \`${api.className(member.parent)}\` is replaced at ${replaced}`;
    }
    return null;
  }

  /**
   * The consumer graph of a tracked value. `seeds` are { node, path }: the value is what `node` evaluates to, read along
   * `path` (property keys). `content` is { kind: 'client' } (a Prisma client value: its reads are handed to the client
   * flow) or { kind: 'instance', object } (an instance of a program class: a value typed as its class is one of its
   * holders, whose uses the W4 check reads itself).
   */
  function closure(seeds, content, label) {
    const visited = new Map(), queue = seeds.map(seed => ({ ...seed, seed: true })), reads = new Set(), bindings = new Set();
    const consumers = new Set(), dependencies = new Set();
    let count = 0, refusal = null;
    const refuse = (node, why) => { refusal ??= `${why} at ${at(node)}`; return []; };
    const family = content.kind === 'instance' ? [...api.familyOf(content.object.declaration)] : [];
    const holder = node => content.kind === 'instance' && api.isHolder(content.object, node);

    const declared = (name, path) => {
      if (ts.isIdentifier(name)) {
        const symbol = api.symbolAt(name);
        if (!path.length && content.kind === 'client') {
          const [declaration] = symbol?.declarations ?? [];
          if (declaration) bindings.add(declaration);   // the client flow follows this binding from here
          return [];
        }
        return api.references(symbol).map(reference => ({ node: api.accessOf(reference) ?? reference, path }));
      }
      if (ts.isObjectBindingPattern(name)) {
        if (!path.length) return refuse(name, 'is destructured (its members are taken out of it)');
        const found = [];
        for (const element of name.elements) {
          if (element.dotDotDotToken) return refuse(element, 'gives what is left of it to a rest element');
          const key = element.propertyName ? keyOf(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (key === undefined) return refuse(element, 'is destructured by a key the program does not fix');
          if (key === path[0]) found.push(...declared(element.name, path.slice(1)));
        }
        return found;
      }
      return refuse(name, 'is destructured as an array');
    };

    const field = (declaration, path, site) => {
      const owner = ts.isParameter(declaration) ? declaration.parent?.parent : declaration.parent;
      if (!owner || !ts.isClassLike(owner) || !api.inProgram(owner)) return refuse(site, 'is stored in a member of no program class');
      if (api.isStatic(declaration) || api.decorated(declaration)) return refuse(site, 'is stored in a static or decorated member');
      const kept = api.keptRaw(owner);
      dependencies.add(`instances of \`${api.className(owner)}\` keep to W4 (raw purpose)`);
      if (kept) return refuse(site, `is stored in \`${declaration.name.getText()}\` of \`${api.className(owner)}\`, whose instances ${kept}`);
      const key = declaration.name.getText();
      const symbol = ts.isParameter(declaration) ? checker.getSymbolsOfParameterPropertyDeclaration(declaration, key)?.[1] : api.symbolAt(declaration.name);
      if (!symbol) return refuse(site, 'is stored in a member that does not resolve');
      consumers.add(`the member \`${key}\` of \`${api.className(owner)}\` (${api.where(declaration)})`);
      return api.memberRefs(symbol).typed.map(access => ({ node: access, path }));
    };

    const step = ({ node, path, seed }) => {
      if (!path.length && !seed) {
        if (content.kind === 'client') { reads.add(node); return []; }
        if (holder(node)) return [];   // a holder of the instance: objectUse reads its every use
      }
      const value = climb(node), parent = value.parent;
      if (!parent) return refuse(node, 'has no use the program shows');
      if (api.inert(value)) return [];
      // A member of it.
      if (api.isAccess(parent) && parent.expression === value) {
        const held = api.outer(parent), use = held.parent, key = keyOf(parent);
        if (key === undefined) return refuse(parent, 'is read by a key the program does not fix');
        if (path.length) {
          if (key !== path[0]) return [];   // another member of the holding object
          // A write of the followed slot through an alias: what is read there afterwards is no longer only the followed
          // value, so no read of it could be taken as that value (a client read or a typed holder).
          if (api.mutated(held)) return refuse(parent, `writes the slot \`${key}\` it is followed through`);
          return [{ node: parent, path: path.slice(1) }];
        }
        if (content.kind === 'client') return [];
        if (['prototype', 'constructor', '__proto__'].includes(key)) return refuse(parent, 'reaches its prototype or constructor');
        if (api.mutated(held)) return refuse(parent, 'is written through a value the W4 check does not type');
        const called = (ts.isCallExpression(use) && use.expression === held) || (ts.isTaggedTemplateExpression(use) && use.tag === held);
        const issue = methodIssue(family, key);
        if (called) { if (issue) return refuse(parent, issue); consumers.add(`\`${key}\` called at ${api.where(parent)}`); return []; }
        if (api.inert(held)) return [];
        return refuse(parent, issue ? `reads \`${key}\` (${issue})` : `takes the method \`${key}\` out of it`);
      }
      // An argument.
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(value)) {
        const index = parent.arguments.indexOf(value), targets = api.argumentTargetsFlow(parent, index);
        if (!targets) return refuse(parent, `is handed to \`${api.snippet(parent.expression)}\`, which this proof does not follow`);
        const found = [];
        for (const parameter of targets) {
          const hazard = api.parameterHazard(parameter);
          if (hazard) return refuse(parameter, hazard);
          consumers.add(`a parameter of ${describe(parameter.parent)}`);
          found.push(...declared(parameter.name, path));
          if (ts.isParameterPropertyDeclaration(parameter, parameter.parent)) found.push(...field(parameter, path, parent));
        }
        return found;
      }
      if ((ts.isCallExpression(parent) && parent.expression === value) || (ts.isTaggedTemplateExpression(parent) && parent.tag === value))
        return refuse(parent, 'is called');
      if (ts.isVariableDeclaration(parent) && parent.initializer === value) return declared(parent.name, path);
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === K.EqualsToken) {
        if (parent.left === value) return [];   // the binding is overwritten here
        const left = api.bare(parent.left);
        if (ts.isIdentifier(left)) return declared(left, path);
        if (api.isAccess(left)) {
          const symbol = ts.isPropertyAccessExpression(left) ? api.resolve(checker.getSymbolAtLocation(left.name))
            : api.resolve(checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(left.expression)), keyOf(left) ?? ''));
          const [declaration] = symbol?.declarations ?? [];
          if (declaration && (ts.isPropertyDeclaration(declaration) || ts.isParameterPropertyDeclaration(declaration, declaration.parent)))
            return field(declaration, path, parent);
          return refuse(parent, 'is stored in a member of an object this proof does not hold');
        }
        return refuse(parent, 'is the source of a destructuring assignment');
      }
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === value)) {
        let owner = parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        if (!owner?.body) return refuse(parent, 'is returned from a function without a body');
        const found = api.callsFlow(owner);
        if (found.escapes.length) return refuse(parent, `is returned from ${describe(owner)}, which is run otherwise than by the calls the program has (${found.escapes.join(', ')})`);
        // An object holding the value, returned where the program calls nothing, has its consumers outside the program
        // (SPEC-F01: a client kept in an object stays refused unless its whole consumer graph is in the program).
        if (path.length && !found.calls.length) return refuse(parent, `is returned in an object from ${describe(owner)}, which the program never calls (its consumers are outside the program)`);
        consumers.add(found.calls.length ? `the ${found.calls.length} call(s) of ${describe(owner)}` : `${describe(owner)}, called nowhere in the program`);
        return found.calls.map(call => ({ node: call, path }));
      }
      if ((ts.isPropertyAssignment(parent) && parent.initializer === value) || (ts.isShorthandPropertyAssignment(parent) && parent.name === value)) {
        const key = keyOf(parent.name);
        if (key === undefined) return refuse(parent, 'is kept under a key the program does not fix');
        if (path.length + 1 > PATH_LIMIT) return refuse(parent, 'is nested deeper than this proof follows');
        const literal = parent.parent, later = literal.properties.slice(literal.properties.indexOf(parent) + 1);
        if (literal.properties.some(member => (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isMethodDeclaration(member))
          && keyOf(member.name) === key)) return refuse(parent, 'shares its key with an accessor or method');
        if (later.some(member => (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) && keyOf(member.name) === key)) return [];
        // A later spread or a key the program does not fix may replace the slot with a value nobody follows.
        const masked = later.find(member => ts.isSpreadAssignment(member) || (member.name && keyOf(member.name) === undefined));
        if (masked) return refuse(masked, `may replace the slot \`${key}\` of its object literal (a later spread, computed key, accessor or method)`);
        consumers.add(`the slot \`${key}\` of the object literal at ${api.where(literal)}`);
        return [{ node: literal, path: [key, ...path] }];
      }
      if (ts.isSpreadAssignment(parent) && parent.expression === value) {
        if (!path.length) return refuse(parent, 'is spread (its own members are copied into another object)');
        const literal = parent.parent, later = literal.properties.slice(literal.properties.indexOf(parent) + 1);
        if (later.some(member => (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) && keyOf(member.name) === path[0])) return [];
        const masked = later.find(member => ts.isSpreadAssignment(member) || (member.name && keyOf(member.name) === undefined)
          || (!(ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) && keyOf(member.name) === path[0]));
        if (masked) return refuse(masked, `may replace the slot \`${path[0]}\` spread into its object literal (a later spread, computed key, accessor or method)`);
        consumers.add(`the spread at ${api.where(parent)}`);
        return [{ node: literal, path }];
      }
      if (ts.isPropertyDeclaration(parent) && parent.initializer === value) return field(parent, path, parent);
      return refuse(parent, `is used in a ${K[parent.kind]}, which this proof does not follow`);
    };

    while (queue.length && !refusal) {
      const item = queue.shift(), stamp = item.path.join('\u0000');
      if (!visited.has(item.node)) visited.set(item.node, new Set());
      if (visited.get(item.node).has(stamp) && !item.seed) continue;
      visited.get(item.node).add(stamp);
      if (++count > NODE_LIMIT) { refusal = `exceeds the raw flow exploration limit (${NODE_LIMIT} uses): unresolved, never a pass, at ${at(item.node)}`; break; }
      queue.push(...step(item));
    }
    const verdict = { purpose: PURPOSE, label, ok: !refusal, why: refusal, uses: count, reads, bindings,
      consumers: [...consumers], dependencies: [...dependencies] };
    certificate.push({ purpose: PURPOSE, kind: 'consumers', label, ok: verdict.ok, why: refusal, uses: count, consumers: verdict.consumers.slice(0, 40),
      dependencies: verdict.dependencies, client_reads: [...reads].map(api.where) });
    return verdict;
  }

  // ── consumers of a client kept in an object literal slot (the client flow) ──
  const slotMemo = new Map();
  /** The consumer graph of the client value that `member` (a property of `literal`) holds. */
  function clientSlot(literal, member) {
    if (slotMemo.has(member)) return slotMemo.get(member);
    const key = keyOf(member.name), later = literal.properties.slice(literal.properties.indexOf(member) + 1);
    const refused = why => ({ ok: false, why, reads: new Set(), bindings: new Set() });
    // The slot as the literal ends up: a later fixed key replaces it (nothing of the client is kept there); a later
    // spread, computed key, accessor or method may replace it with a value nobody follows.
    const masked = later.find(item => ts.isSpreadAssignment(item) || (item.name && keyOf(item.name) === undefined)
      || (!(ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && keyOf(item.name) === key));
    const proof = key === undefined ? refused(`the client is kept under a key the program does not fix at ${at(member)}`)
      : masked ? refused(`may replace the slot \`${key}\` of its object literal (a later spread, computed key, accessor or method) at ${at(masked)}`)
        : later.some(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && keyOf(item.name) === key)
          ? { ok: true, why: null, reads: new Set(), bindings: new Set(), consumers: [], dependencies: [] }
          : closure([{ node: literal, path: [key] }], { kind: 'client' }, `client in \`${key}\` of the object literal at ${api.where(literal)}`);
    if (!proof.ok && !proof.uses) certificate.push({ purpose: PURPOSE, kind: 'consumers', label: `client in \`${key ?? '?'}\` of the object literal at ${api.where(literal)}`,
      ok: false, why: proof.why, uses: 0, consumers: [], dependencies: [], client_reads: [] });
    slotMemo.set(member, proof);
    return proof;
  }

  // ── consumers of an instance handed on (W4, raw purpose) ──
  const handMemo = new Map();
  /** Whether the use at `start` (a holder of `object` handed on there) keeps the instance where the program follows it. */
  function handOn(object, start) {
    const memo = handMemo.get(object.declaration) ?? new Map();
    handMemo.set(object.declaration, memo);
    if (memo.has(start)) return memo.get(start);
    memo.set(start, { ok: false, why: 'is reached again while its consumers are proved' });
    const proof = closure([{ node: start, path: [] }], { kind: 'instance', object }, `an instance of \`${api.className(object.declaration)}\` handed on at ${api.where(start)}`);
    memo.set(start, proof);
    return proof;
  }

  // ── callback slots (the holder handed on as `this` of a called field) ──
  /** Why a function value can observe the `this` it is called with, else null. */
  function ownThis(fn) {
    let found = null;
    const walk = node => {
      if (found) return;
      if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node))) return;
      if (node.kind === K.ThisKeyword || (ts.isIdentifier(node) && node.text === 'arguments')) found = node;
      ts.forEachChild(node, walk);
    };
    if (fn.body) walk(fn.body);
    for (const parameter of fn.parameters ?? []) walk(parameter);
    return found ? `\`${api.snippet(fn)}\` reads its own \`${found.getText()}\` at ${api.where(found)}` : null;
  }
  /** The calls of a function or method whose parameter is read (`assumed`: the instances of that class keep to W4 being
   *  the very obligation in progress), or why not. */
  function callsFor(owner, assumed) {
    if (ts.isMethodDeclaration(owner) && ts.isClassLike(owner.parent)) {
      const symbol = api.symbolAt(owner.name), replaced = symbol && api.memberChanged(symbol);
      if (!symbol || replaced) return { why: `${describe(owner)} is replaced${replaced ? ` at ${replaced}` : ''}` };
      if (!assumed.has(owner.parent)) {
        const kept = api.keptRaw(owner.parent);
        if (kept) return { why: `${describe(owner)} is a method of \`${api.className(owner.parent)}\`, whose instances ${kept}` };
      }
      const calls = [];
      for (const access of api.memberRefs(symbol).typed) {
        const held = api.outer(access), use = held.parent;
        if (ts.isCallExpression(use) && use.expression === held) calls.push(use);
        else if (!api.inert(held)) return { why: `${describe(owner)} is taken out at ${at(access)}` };
      }
      return { calls };
    }
    const found = api.callsFlow(owner);
    return found.escapes.length ? { why: `${describe(owner)} is run otherwise than by its calls (${found.escapes.join(', ')})` } : { calls: found.calls };
  }
  function thisFree(expression, assumed, seen, trail) {
    const node = api.bare(expression);
    if (api.nothing(node)) return null;
    if (ts.isArrowFunction(node)) { trail.push(`the arrow function at ${api.where(node)}`); return null; }
    if (ts.isFunctionExpression(node)) { const why = ownThis(node); if (!why) trail.push(`the function at ${api.where(node)}`); return why; }
    if (!ts.isIdentifier(node)) return `\`${api.snippet(node)}\` is a ${K[node.kind]}, not a function this proof reads`;
    const symbol = api.symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
    if (declarations.length !== 1) return `\`${node.text}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}`;
    if (seen.has(declaration)) return null;   // this producer's every value is read where it was first met
    seen.add(declaration);
    const { plain, other } = api.writesOf(symbol);
    if (other.length) return `\`${node.text}\` is changed at ${api.where(other[0].at)}`;
    for (const right of plain) { const why = thisFree(right, assumed, seen, trail); if (why) return why; }
    if (api.isConst(declaration) && declaration.initializer) return thisFree(declaration.initializer, assumed, seen, trail);
    if (ts.isFunctionDeclaration(declaration)) {
      // A function without its body in the program (an ambient declaration, an overload) runs code nobody read.
      if (!declaration.body || !api.inProgram(declaration) || api.decorated(declaration)) return `${describe(declaration)} has no body in the program`;
      const why = ownThis(declaration);
      if (!why) trail.push(describe(declaration));
      return why;
    }
    if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent) && ts.isIdentifier(declaration.name) && !declaration.dotDotDotToken) {
      const hazard = api.parameterHazard(declaration);
      if (hazard) return hazard;
      const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - api.shift(owner);
      const found = callsFor(owner, assumed);
      if (found.why) return found.why;
      if (!found.calls.length) return `${describe(owner)}, whose parameter fills the field, is called nowhere in the program (an outside caller's value)`;
      trail.push(`every call of ${describe(owner)} (${found.calls.length})`);
      for (const call of found.calls) {
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return `${api.where(call)}: a spread argument`;
        const argument = call.arguments[index] ?? declaration.initializer;
        if (!argument) continue;
        const why = thisFree(argument, assumed, seen, trail);
        if (why) return why;
      }
      return null;
    }
    return `\`${node.text}\` is a ${K[declaration.kind]}, not a function this proof reads`;
  }
  const callbackMemo = new Map();
  /**
   * Whether calling the field `key` of `object` with a holder as `this` keeps the holder: every value the field can hold
   * (its initializer, every write by `=` through any receiver the check types, through parameters at every call) is a
   * function that cannot observe `this`. The instances keeping to W4 is the obligation in progress (it is decided with
   * every other use of their holders), so the method calls of the class itself are read as complete.
   */
  function callbackSlot(object, key) {
    const stamp = `${api.where(object.declaration)}#${key}`;
    if (callbackMemo.has(stamp)) return callbackMemo.get(stamp);
    const family = [...api.familyOf(object.declaration)], fields = familyMembers(family, key), trail = [];
    let why = fields.length ? null : `no field \`${key}\``;
    for (const declaration of fields) {
      if (why) break;
      if (!ts.isPropertyDeclaration(declaration) || api.decorated(declaration)) { why = `\`${key}\` of \`${api.className(declaration.parent)}\` is not a plain field`; break; }
      const values = declaration.initializer ? [declaration.initializer] : [];
      for (const access of api.slotWrites(declaration, declaration.parent)) {
        const held = api.outer(access), parent = held.parent;
        if (!(ts.isBinaryExpression(parent) && parent.left === held && parent.operatorToken.kind === K.EqualsToken)) { why = `\`${key}\` is written other than by \`=\` at ${at(access)}`; break; }
        values.push(parent.right);
      }
      const symbol = api.symbolAt(declaration.name);
      const untyped = symbol ? api.memberRefs(symbol).untyped.find(access => api.mutated(api.outer(access))) : null;
      if (!why && untyped) why = `\`${key}\` may be written through a value the check does not type at ${at(untyped)}`;
      for (const value of why ? [] : values) {
        why = thisFree(value, new Set(family), new Set(), trail);
        if (why) break;
      }
    }
    const proof = { ok: !why, why: why && `the field \`${key}\` called with its holder as \`this\`: ${why}`, producers: trail };
    certificate.push({ purpose: PURPOSE, kind: 'callback slot', label: stamp, ok: proof.ok, why: proof.why, producers: trail.slice(0, 40),
      dependencies: [`instances of \`${api.className(object.declaration)}\` keep to W4 (raw purpose): decided with every other use of their holders`] });
    callbackMemo.set(stamp, proof);
    return proof;
  }

  // ── producers of a receiver ──
  /** The concrete program classes `expression` can evaluate to (null and undefined left out: a member call on them
   *  throws), or why the set is not known. Every source is explored once per query; nothing is assumed of a source
   *  still being explored, and an empty set is a refusal (a cycle without a concrete seed proves nothing). */
  function producers(expression) {
    const classes = new Set(), visited = new Set(), sources = [];
    let why = null;
    const walk = (value, depth) => {
      if (why) return;
      const node = api.bare(value);
      if (depth > PRODUCER_DEPTH) { why = `the producers of \`${api.snippet(node)}\` are deeper than this proof follows`; return; }
      if (visited.has(node)) return;
      visited.add(node);
      if (ts.isAwaitExpression(node)) return walk(node.expression, depth + 1);
      if (api.nothing(node)) return;
      if (ts.isConditionalExpression(node)) { walk(node.whenTrue, depth + 1); walk(node.whenFalse, depth + 1); return; }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === K.BarBarToken || operator === K.QuestionQuestionToken) { walk(node.left, depth + 1); walk(node.right, depth + 1); return; }
        if (operator === K.AmpersandAmpersandToken || operator === K.CommaToken) return walk(node.right, depth + 1);
        why = `\`${api.snippet(node)}\` is a ${ts.tokenToString(operator)} expression`; return;
      }
      if (ts.isNewExpression(node)) {
        const made = ts.isIdentifier(api.bare(node.expression)) ? api.directClass(api.bare(node.expression)) : null;
        if (!made) { why = `\`${api.snippet(node)}\` does not name a class of the program directly`; return; }
        classes.add(made); sources.push(`new \`${api.className(made)}\` at ${api.where(node)}`); return;
      }
      if (ts.isIdentifier(node)) {
        const symbol = api.symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
        if (declarations.length !== 1) { why = `\`${node.text}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}`; return; }
        if ((ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) || (ts.isParameter(declaration) && ts.isIdentifier(declaration.name) && !declaration.dotDotDotToken)) {
          const { plain, other } = api.writesOf(symbol);
          if (other.length) { why = `\`${node.text}\` is changed at ${api.where(other[0].at)}`; return; }
          for (const right of plain) walk(right, depth + 1);
          if (ts.isVariableDeclaration(declaration)) { if (declaration.initializer) walk(declaration.initializer, depth + 1); return; }
          const hazard = api.parameterHazard(declaration);
          if (hazard) { why = hazard; return; }
          const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - api.shift(owner);
          const found = api.callsFlow(owner);
          if (found.escapes.length) { why = `\`${node.text}\` is a parameter of ${describe(owner)}, which is run otherwise than by its calls (${found.escapes.join(', ')})`; return; }
          // As F02 and W3 read a parameter: one the program never fills is no known producer (an outside caller's value).
          if (!found.calls.length) { why = `\`${node.text}\` is a parameter of ${describe(owner)}, which nothing in the program calls`; return; }
          sources.push(`every call of ${describe(owner)} (${found.calls.length})`);
          for (const call of found.calls) {
            if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) { why = `${api.where(call)}: a spread argument`; return; }
            const argument = call.arguments[index] ?? declaration.initializer;
            if (argument) walk(argument, depth + 1);
          }
          return;
        }
        why = `\`${node.text}\` is a ${K[declaration.kind]}`; return;
      }
      if (ts.isCallExpression(node)) {
        const owners = api.functionsFlow(node.expression);
        if (!owners?.length) { why = `\`${api.snippet(node)}\` is a call this proof does not follow`; return; }
        for (const owner of owners) {
          const returned = api.returnsOf(owner);
          sources.push(`the returns of ${describe(owner)}`);
          for (const result of returned) walk(result, depth + 1);
        }
        return;
      }
      why = `\`${api.snippet(node)}\` is a ${K[node.kind]}, whose producers this proof does not read`;
    };
    walk(expression, 0);
    if (!why && !classes.size) why = `no concrete producer of \`${api.snippet(expression)}\` (an empty set or a cycle without a seed proves nothing)`;
    return { classes, sources, why };
  }
  const targetMemo = new Map();
  /** The methods a member call on an interface-typed receiver runs: the method of every concrete producer, or why not. */
  function targetsOf(access) {
    if (targetMemo.has(access)) return targetMemo.get(access);
    targetMemo.set(access, { why: 'is reached again while its producers are proved' });
    const key = keyOf(access);
    let proof;
    if (key === undefined) proof = { why: `\`${api.snippet(access)}\` is called by a key the program does not fix` };
    else {
      const found = producers(access.expression);
      if (found.why) proof = { why: found.why };
      else {
        const targets = [], dependencies = [];
        for (const declaration of found.classes) {
          const family = [...api.familyOf(declaration)];
          const issue = methodIssue(family, key) || api.keptRaw(declaration);
          dependencies.push(`instances of \`${api.className(declaration)}\` keep to W4 (raw purpose)`);
          if (issue) { proof = { why: `\`${key}\` of \`${api.className(declaration)}\`: ${issue}` }; break; }
          targets.push(...familyMembers(family, key));
        }
        proof ??= { targets: [...new Set(targets)], sources: found.sources, dependencies };
      }
    }
    certificate.push({ purpose: PURPOSE, kind: 'producers', label: `${api.where(access)} \`${api.snippet(access)}\``, ok: !proof.why, why: proof.why ?? null,
      producers: proof.sources ?? [], targets: (proof.targets ?? []).map(target => `${describe(target)}`), dependencies: proof.dependencies ?? [] });
    targetMemo.set(access, proof);
    return proof;
  }

  return { purpose: PURPOSE, clientSlot, handOn, callbackSlot, targetsOf, producers, certificate };
}

module.exports = { buildRawFlow, PURPOSE };
