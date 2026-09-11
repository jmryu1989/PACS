# coding: utf-8
"""One unchanged VR20 execution with bounded resize failure observations."""
import json
import unittest

from test_volume_rendering import VolumeRenderingE2E


class VrResizeProbeE2E(VolumeRenderingE2E):
    def vr(self, viewer):
        dialog = super().vr(viewer)
        self.probe_viewer = viewer
        viewer.evaluate("""() => {
          if (window.kinVrResizeProbe) return;
          const events = [], add = (kind, extra = {}) => {
            events.push({kind, ...extra}); if (events.length > 64) events.shift();
          };
          const snapshot = () => {
            const dialog = document.querySelector('#kin-volume-rendering');
            const select = dialog?.querySelector('[aria-label="Sculpt Tool"]');
            const host = dialog?.querySelector('[data-kin-vr-render]');
            const box = node => {const r = node?.getBoundingClientRect();
              return r ? {width:r.width,height:r.height,x:r.x,y:r.y} : null;};
            return {open:!!dialog?.open, screen:[innerWidth,innerHeight],
              select:box(select), host:box(host),
              status:document.querySelector('#kin-volume-orientation [role=status]')?.textContent?.slice(0,400),
              dialogStatus:dialog?.querySelector('[role=status]')?.textContent?.slice(0,400)};
          };
          const enabled = cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]'));
          const instrument = (object, method) => {
            const original = object?.[method];
            if (typeof original !== 'function') throw Error('Probe cannot instrument '+method);
            object[method] = function (...args) {
              add(method+'-start',snapshot());
              try {const result=original.apply(this,args);add(method+'-return',snapshot());return result;}
              catch(error){add(method+'-throw',{name:error.name,message:String(error.message).slice(0,400),...snapshot()});throw error;}
            };
          };
          instrument(enabled.renderingEngine || enabled.viewport.getRenderingEngine(), 'resize');
          instrument(enabled.viewport, 'render');
          window.addEventListener('resize',()=>add('window-resize',snapshot()));
          window.kinVrResizeProbe = () => ({events,final:snapshot()});
          add('installed',snapshot());
        }""")
        return dialog

    def test_vr_resize_probe_01_original_vr20(self):
        try:
            super().test_vr_20_sculpt_draft_cancel_resize_reset_and_crop_transfer()
        finally:
            viewer = getattr(self, 'probe_viewer', None)
            if viewer is not None and not viewer.is_closed():
                print('VR_RESIZE_PROBE ' + json.dumps(viewer.evaluate(
                    '() => window.kinVrResizeProbe?.() || {installed:false}'),
                    ensure_ascii=False), flush=True)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([VrResizeProbeE2E('test_vr_resize_probe_01_original_vr20')])
