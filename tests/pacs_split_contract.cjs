'use strict';
// D73 byte pins are intentional here: S9-U0b is an explicitly behaviour-preserving move.
// These are provenance/equivalence checks, not permission or business-rule assertions.
// Round 2 must review each receiver/wiring correspondence; never regenerate baselines from moved code.
// Text, SQL literal and binding hashes use the LF form (`lf`) so a CRLF checkout and the LF CI pin the same content.
const assert = require('node:assert/strict');
const { ts, sha256, lf } = require('./pacs_source.cjs');

function fingerprint(source, node) {
  const sql = [];
  function walk(child) {
    if (ts.isTaggedTemplateExpression(child)) {
      const template = child.template;
      const literals = ts.isNoSubstitutionTemplateLiteral(template) ? [template] :
        [template.head, ...template.templateSpans.map(span => span.literal)];
      const expressions = ts.isNoSubstitutionTemplateLiteral(template) ? [] : template.templateSpans.map(span => {
        const bindings = [];
        function bind(part) {
          if (ts.isIdentifier(part) && !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part)) {
            const symbol = source.resolveSymbol(part);
            bindings.push({ name: part.text, declarations: symbol.declarations.map(declaration => ({
              kind: ts.SyntaxKind[declaration.kind], text_sha256: sha256(lf(declaration.getText())),
            })) });
          }
          ts.forEachChild(part, bind);
        }
        bind(span.expression);
        return { expression: lf(span.expression.getText()), bindings };
      });
      sql.push({ receiver: lf(child.tag.getText()), raw: literals.map(literal => lf(literal.rawText ?? literal.text)),
        cooked: literals.map(literal => lf(literal.text)), expressions });
    }
    ts.forEachChild(child, walk);
  }
  walk(node);
  return { text_sha256: sha256(lf(node.getText())), sql };
}
function assertContract(source) {
  const counts = source.validate();
  assert.deepEqual(counts, { members: 125, declarations: 57 }, 'complete approved member/declaration map');
  for (const entry of source.spec.entries) {
    assertEntry(source, entry);
  }
  return counts;
}
function assertEntry(source, entry) {
  const actual = fingerprint(source, source.locate(entry.live));
  assert.deepEqual(actual.sql, entry.baseline.sql, `SQL text/binding provenance: ${entry.id}`);
  assert.equal(actual.text_sha256, entry.baseline.text_sha256, `Move equivalence: ${entry.id}`);
}
module.exports = { fingerprint, assertContract, assertEntry };
