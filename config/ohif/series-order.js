
// FB-064: the Studies panel lists a study's series by Series Number, then series date and time, the same order on every
// opening. The stock panel lists display sets in the order their metadata arrived and sorts them only while its own
// settings dropdown is open. The parts of one split series compare equal, so the stable sort keeps their order.
// worklist-v0/hpacs-lite/viewer-series-strip.js orders the series strip by the same rule.
function kinSeriesOrder(a, b) {
  const number = value => { const text = String(value ?? '').trim(), n = Number(text); return text && Number.isFinite(n) ? n : Infinity; };
  const stamp = set => { const date = String(set.SeriesDate ?? '').trim(); return date ? date + String(set.SeriesTime ?? '').trim() : '￿'; };
  const order = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  // A missing number goes last (Infinity - Infinity is NaN, which falls through to the next key).
  return number(a.SeriesNumber) - number(b.SeriesNumber) || order(stamp(a), stamp(b)) ||
    order(String(a.SeriesInstanceUID ?? ''), String(b.SeriesInstanceUID ?? ''));
}

function kinCreateSeriesOrder() {
  let subscription = null;
  return { id: 'kin.series-order', onModeEnter({ servicesManager }) {
    subscription?.unsubscribe(); subscription = null;
    const service = servicesManager.services.displaySetService;
    if (typeof service?.sortDisplaySets !== 'function') return;
    // Sorted only when a series arrives out of order; the sort's own change event redraws the panel.
    const apply = () => {
      const sets = service.getActiveDisplaySets();
      if (sets.some((set, index) => index && kinSeriesOrder(sets[index - 1], set) > 0)) service.sortDisplaySets(kinSeriesOrder, 'ascending');
    };
    subscription = service.subscribe(service.EVENTS.DISPLAY_SETS_ADDED, apply);
    apply();
  }, onModeExit() { subscription?.unsubscribe(); subscription = null; } };
}
