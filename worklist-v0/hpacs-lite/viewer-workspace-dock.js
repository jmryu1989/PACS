/* Keep viewer controls in their own document so their live state and listeners
 * survive panel switches. Reserve space instead of covering diagnostic pixels. */
window.KinViewerWorkspaceDock = function (w) {
  'use strict';
  const d = w.document;
  const existing = d.getElementById('kin-workspace-dock');
  if (existing) { existing.refreshPanels(); return; }
  const root = d.getElementById('root');
  const panels = ['kin-viewer-history', 'kin-viewer-layout'].map(id => d.getElementById(id));
  if (!root || panels.some(p => !p)) return;
  const style = d.createElement('style');
  style.textContent = `
    body.kin-docked { --kin-dock-height: 42px; }
    body.kin-docked.kin-dock-open { --kin-dock-height: min(280px, 45vh); }
    body.kin-docked #root { height: calc(100vh - var(--kin-dock-height)); overflow: hidden; }
    body.kin-docked #root > div { height: 100%; display: flex; flex-direction: column; }
    body.kin-docked #root > div > * { flex-shrink: 0; }
    body.kin-docked #root > div > .flex { flex: 1; min-height: 0; height: auto !important; }
    #kin-workspace-dock { position: fixed; bottom: 0; left: 0; right: 0; height: var(--kin-dock-height); display: flex; flex-direction: column; background: #101e32; color: #e1ecfc; border-top: 1px solid #657c9f; font: 13px sans-serif; }
    #kin-workspace-dock nav { display: flex; gap: 8px; align-items: center; height: 42px; padding: 4px 10px; flex: none; }
    #kin-workspace-dock button { border: 1px solid #657c9f; border-radius: 4px; padding: 5px 10px; }
    #kin-workspace-dock button[aria-expanded=true] { background: #315681; }
    #kin-workspace-dock > details { position: static !important; width: 100% !important; max-width: none !important; max-height: none !important; min-height: 0; flex: 1; overflow: auto !important; border: 0 !important; border-radius: 0 !important; margin: 0; }
    #kin-workspace-dock > details[hidden] { display: none !important; }
    #kin-workspace-dock > details > summary { display: none; }
    #kin-workspace-dock label { max-width: 650px; display: block; }
  `;
  d.head.append(style);
  const dock = d.createElement('section'); dock.id = 'kin-workspace-dock'; dock.setAttribute('aria-label', '영상 도구');
  const nav = d.createElement('nav'); nav.setAttribute('aria-label', '영상 도구 패널'); dock.append(nav);
  let selected = -1;
  const buttons = ['측정·주석', '비교 작업·배치'].map((label, i) => {
    const b = d.createElement('button'); b.type = 'button'; b.textContent = label;
    b.setAttribute('aria-controls', panels[i].id); b.setAttribute('aria-expanded', 'false');
    b.onclick = () => {
      selected = selected === i ? -1 : i;
      panels.forEach((p, n) => { p.hidden = selected !== n; p.open = true; buttons[n].setAttribute('aria-expanded', String(selected === n)); });
      d.body.classList.toggle('kin-dock-open', selected !== -1);
      w.requestAnimationFrame(() => w.dispatchEvent(new w.Event('resize')));
    };
    nav.append(b); return b;
  });
  panels.forEach(p => { p.hidden = true; dock.append(p); });
  // OHIF can re-enter a mode without replacing the document. Adopt replacement
  // panels after their owners mount them, retaining the selected tool category.
  dock.refreshPanels = () => {
    ['kin-viewer-history', 'kin-viewer-layout'].forEach((id, i) => {
      const next = d.getElementById(id);
      if (next && next !== panels[i]) {
        panels[i] = next; next.hidden = selected !== i; next.open = true; dock.append(next);
      }
    });
  };
  d.body.append(dock); d.body.classList.add('kin-docked');
  w.requestAnimationFrame(() => w.dispatchEvent(new w.Event('resize')));
};
