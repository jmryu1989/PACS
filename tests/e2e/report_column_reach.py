"""Reach of the report action row from the arrival state, for served tests that reveal it before the first press.

Provisional until Minhoon confirms (11-03 commander): at 1366x768 in Reading Workspace the stacked report card may
start the action row (`.report-p .rbtns`) below the first screen. Nobody uses the product before release, so the
layout stays while the question is open. A test that scrolls for the reader may only do so after this module has
recorded the arrival state, and the scroll must be one scroll of the scrollable report column, which then shows the
entry whole. If Minhoon answers that the row must be on the first screen (or the product pins `.rbtns` in view), the
callers delete their reveal and G0 / the entry hit test read the arrival state again, as before 92ddc62.

READ only reads. It never scrolls, focuses or clicks.
"""

READ = r"""([rowSelector, entrySelector]) => {
  const q = s => document.querySelector(s);
  const row = q(rowSelector), entry = q(entrySelector), column = q('.report-p'), side = q('.right');
  const doc = document.scrollingElement;
  const name = el => el ? (el.id || String(el.className || '') || el.tagName.toLowerCase()) : null;
  const n = v => parseFloat(v) || 0, LU = 1 / 64;
  const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  // What the reader can see of an element: the viewport cut by every clipping ancestor's padding box.
  const clipOf = el => { let c = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    for (let a = el.parentElement; a && a !== doc; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = a.getBoundingClientRect();
      c = { top: Math.max(c.top, r.top + n(cs.borderTopWidth)), bottom: Math.min(c.bottom, r.bottom - n(cs.borderBottomWidth)),
            left: Math.max(c.left, r.left + n(cs.borderLeftWidth)), right: Math.min(c.right, r.right - n(cs.borderRightWidth)) };
    }
    return c; };
  const whole = el => { if (!el) return false; const r = rect(el), c = clipOf(el);
    return r.bottom > r.top && r.right > r.left && r.top >= c.top - LU && r.bottom <= c.bottom + LU
      && r.left >= c.left - LU && r.right <= c.right + LU; };
  // Every scroll container between the row and the page, user-scrollable or not: a script can move an
  // overflow:hidden box that no wheel reaches, and such a move must not count as the reader's scroll.
  const scrollers = [];
  for (let a = row ? row.parentElement : null; a && a !== doc; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowY === 'visible') continue;
    scrollers.push({ name: name(a), top: a.scrollTop, max: a.scrollHeight - a.clientHeight,
      user: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
      reportColumn: !!column && !!side && (a === column || a.contains(column)) && (a === side || side.contains(a)) });
  }
  return { viewport: [innerWidth, innerHeight],
    present: !!row && !!entry && !!column && column.contains(row) && row.contains(entry),
    row: row ? rect(row) : null, entry: entry ? rect(entry) : null, entryClip: entry ? clipOf(entry) : null,
    entryWhole: whole(entry), scrollers, document: doc ? [doc.scrollTop, doc.scrollLeft] : null };
}"""


def reach_problems(before, after):
    """Problems with "the row is in the scrollable report column and one scroll of that column reaches its entry".

    `before` is READ at arrival, `after` READ once the test's reveal has run. An entry already whole at arrival must
    not have needed any scroll."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return ['reach: unreadable (%r, %r)' % (before, after)]
    if not before.get('present') or not after.get('present'):
        return ['reach: the action row, its entry or the report column is missing (before %r, after %r)'
                % (before.get('present'), after.get('present'))]
    problems = []
    names = [[s['name'] for s in state['scrollers']] for state in (before, after)]
    if names[0] != names[1]:
        return ['reach: the scroll containers changed during the reveal %r -> %r' % tuple(names)]
    if before['document'] != after['document']:
        problems.append('reach: the page itself scrolled %r -> %r' % (before['document'], after['document']))
    moved = [(b, a) for b, a in zip(before['scrollers'], after['scrollers']) if b['top'] != a['top']]
    if before['entryWhole']:
        if moved:
            problems.append('reach: the entry was already in view, yet %s scrolled' % [b['name'] for b, _ in moved])
        return problems
    if not any(s['user'] and s['reportColumn'] and s['max'] > 0 for s in before['scrollers']):
        problems.append('reach: the entry %r is out of view (clip %r) and no scrollable report column holds the row'
                        % (before['entry'], before['entryClip']))
    if len(moved) != 1:
        problems.append('reach: %d scroll containers moved %s; one scroll of the report column must reach the row'
                        % (len(moved), [b['name'] for b, _ in moved]))
    elif not (moved[0][0]['user'] and moved[0][0]['reportColumn']):
        problems.append('reach: %s moved, which is not a user-scrollable report column' % moved[0][0]['name'])
    if not after['entryWhole']:
        problems.append('reach: after the scroll the entry %r is still not whole in view (clip %r)'
                        % (after['entry'], after['entryClip']))
    return problems


def self_check():
    """Pure failure paths for reach_problems, for the callers' oracle self checks (no browser)."""
    column = {'name': 'right', 'top': 0, 'max': 120, 'user': True, 'reportColumn': True}
    inner = {'name': 'panel report-p', 'top': 0, 'max': 14, 'user': True, 'reportColumn': True}
    elsewhere = {'name': 'left', 'top': 0, 'max': 300, 'user': True, 'reportColumn': False}
    below = {'present': True, 'row': {'top': 811}, 'entry': {'top': 815, 'bottom': 837}, 'entryClip': {'bottom': 768},
             'entryWhole': False, 'scrollers': [inner, column], 'document': [0, 0]}
    revealed = dict(below, entryWhole=True, scrollers=[inner, dict(column, top=69)])
    problems = []
    if reach_problems(below, revealed):
        problems.append('one scroll of the report column revealing the entry must pass: %r' % reach_problems(below, revealed))
    shown = dict(below, entryWhole=True)
    if reach_problems(shown, shown):
        problems.append('an entry already in view with nothing scrolled must pass')
    rejected = (
        ('a page scroll', below, dict(revealed, document=[40, 0])),
        ('two scrolls', below, dict(revealed, scrollers=[dict(inner, top=14), dict(column, top=55)])),
        ('a scroll that leaves the entry out of view', below, dict(revealed, entryWhole=False)),
        ('no scroll at all', below, dict(below)),
        ('a script-only scroll', dict(below, scrollers=[inner, dict(column, user=False)]),
         dict(revealed, scrollers=[inner, dict(column, user=False, top=69)])),
        ('a scroll outside the report column', dict(below, scrollers=[elsewhere]),
         dict(revealed, scrollers=[dict(elsewhere, top=69)])),
        ('a scroll when the entry was already in view', shown, dict(revealed)),
        ('a row outside the report column', dict(below, present=False), revealed),
    )
    for label, before, after in rejected:
        if not reach_problems(before, after):
            problems.append('reach must reject %s' % label)
    return problems
