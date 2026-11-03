"""Reach of the report action row from the arrival state, for served tests that reveal it before the first press.

Provisional until Minhoon confirms (11-03 commander): at 1366x768 in Reading Workspace the stacked report card may
start the action row (`.report-p .rbtns`) below the first screen. Nobody uses the product before release, so the
layout stays while the question is open. A test that brings the entry into view may only do so after this module has
recorded the arrival state, and the move is judged here: whatever moved is a user-scrollable container of the report
column (how many is not judged), the page itself stays put, and the entry is then whole in view. Whether the move was
the reader's input is the caller's part: this module compares two states and cannot tell a wheel from a script
scroll. The Study Panel DOM tests move by the reader's wheel and Tab (study_panel_page_dom_test.wheel_into_view,
tab_into_view). If Minhoon answers that the row must be on the first screen (or the product pins `.rbtns` in view), the
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
  // A container of the report column is the column itself, one around it inside `.right`, or one inside it
  // (review fix13 F3: a scrolling wrapper within the report card is the same reader's scroll).
  const scrollers = [];
  for (let a = row ? row.parentElement : null; a && a !== doc; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowY === 'visible') continue;
    scrollers.push({ name: name(a), top: a.scrollTop, max: a.scrollHeight - a.clientHeight,
      user: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
      reportColumn: !!column && !!side && (a.contains(column) || column.contains(a)) && side.contains(a) });
  }
  return { viewport: [innerWidth, innerHeight],
    present: !!row && !!entry && !!column && column.contains(row) && row.contains(entry),
    row: row ? rect(row) : null, entry: entry ? rect(entry) : null, entryClip: entry ? clipOf(entry) : null,
    entryWhole: whole(entry), scrollers, document: doc ? [doc.scrollTop, doc.scrollLeft] : null };
}"""


LU = 1 / 64  # READ's layout-unit slack, for the same four-side test on its numbers


def whole_after_rounding(entry, clip, bottom_rounding):
    """READ's `whole` on its own numbers, except that the entry's bottom may pass the clip by `bottom_rounding`."""
    return (entry['bottom'] > entry['top'] and entry['right'] > entry['left']
            and entry['top'] >= clip['top'] - LU and entry['bottom'] <= clip['bottom'] + max(LU, bottom_rounding)
            and entry['left'] >= clip['left'] - LU and entry['right'] <= clip['right'] + LU)


def reach_problems(before, after, bottom_rounding=0):
    """Problems with "the row is in the scrollable report column and ordinary scrolling of that column reaches its
    entry".

    `before` is READ at arrival, `after` READ once the test's reveal has run. An entry already whole at arrival must
    not have needed any scroll. An entry out of view at arrival needs something to have moved, and every container
    that moved must be one the reader can scroll inside the report column; their number is not part of the judgment.

    Explicit exception a caller turns on for itself (the default is the served tests' judgment):
    `bottom_rounding` - how far, in px, the entry's bottom may still pass
    its clip after the reveal: the browser's scroll to a focused control (Tab) moves whole pixels, so an entry at a
    fractional position can stop short of the edge by less than one (fix14: 0.453 px at 900x768; the wheel needs none). That part is really cut off until the reader's next wheel step. Top, left and right
    are still judged exactly."""
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
    if not moved:
        problems.append('reach: nothing scrolled, yet the entry was out of view at arrival')
    for b, _ in moved:
        if not (b['user'] and b['reportColumn']):
            problems.append('reach: %s moved, which is not a user-scrollable report column' % b['name'])
    whole = after['entryWhole'] or (bottom_rounding > 0 and after.get('entry') and after.get('entryClip')
                                    and whole_after_rounding(after['entry'], after['entryClip'], bottom_rounding))
    if not whole:
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
    nested = dict(revealed, scrollers=[dict(inner, top=14), dict(column, top=55)])
    # Review fix13 F3: a scroll container inside the report card (READ counts it as the report column) moving alone.
    wrapper = {'name': 'inner', 'top': 0, 'max': 120, 'user': True, 'reportColumn': True}
    inside = (dict(below, scrollers=[wrapper]), dict(revealed, scrollers=[dict(wrapper, top=70)]))
    for label, before, after in (('one report-column scroll', below, revealed), ('two report-column scrolls', below, nested),
                                 ('a scroll container inside the report card', *inside)):
        if reach_problems(before, after):
            problems.append('%s revealing the entry must pass: %r' % (label, reach_problems(before, after)))
    shown = dict(below, entryWhole=True)
    if reach_problems(shown, shown):
        problems.append('an entry already in view with nothing scrolled must pass')
    outside = [inner, dict(column, reportColumn=False)]
    rejected = (
        ('a page scroll', below, dict(revealed, document=[40, 0])),
        ('two scrolls, one outside the report column', dict(below, scrollers=outside),
         dict(nested, scrollers=[dict(s, top=t) for s, t in zip(outside, (14, 55))])),
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
    # The explicit exception. A 100x22 Save at the bottom of a card clipped to 900..1000 x 0..761 after the scroll.
    clip = {'top': 0, 'bottom': 761, 'left': 900, 'right': 1000}
    save = {'top': 739.45, 'bottom': 761.45, 'left': 900, 'right': 1000}
    cut = lambda **edges: dict(revealed, entryWhole=False, entry=dict(save, **edges), entryClip=clip)
    if reach_problems(below, cut(), bottom_rounding=0.5):
        problems.append('reach must pass 0.45 px of bottom left by a whole-pixel scroll, with bottom_rounding: %r'
                        % reach_problems(below, cut(), bottom_rounding=0.5))
    rejected = (
        ('0.45 px of bottom without bottom_rounding', below, cut(), {}),
        ('a bottom cut by 60 px', below, cut(bottom=821), {'bottom_rounding': 0.5}),
        ('a 160 px Save cut by 60 px on the right', below, cut(bottom=761, right=1060), {'bottom_rounding': 0.5}),
        ('a 160 px Save cut by 60 px on the left', below, cut(bottom=761, left=840), {'bottom_rounding': 0.5}),
        ('0.45 px cut on the right', below, cut(bottom=761, right=1000.45), {'bottom_rounding': 0.5}),
        ('0.45 px cut at the top', below, cut(top=-0.45, bottom=21.55), {'bottom_rounding': 0.5}),
    )
    for label, before, after, options in rejected:
        if not reach_problems(before, after, **options):
            problems.append('reach must reject %s' % label)
    return problems
