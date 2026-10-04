# coding: utf-8
"""TEST-S8-SCULPT-PERF BU-T02 (S8-U1a fix9): today's mask generator and the fixed B-u mask program decide alike at the
native boundary sweep, within the approved O9 rule.

No stack: one page with the repository's own volume-sculpt.js (today's generator, read-only) and volume-vr-masks.js (the
fixed program and its packed numbers), served from this checkout. The sweep is tests/o9_band.py's rebuilt case list (the
R-001 fixture, the dy sweep, a rotated polygon, a non-identity projection, a rectangle, an ellipse), so the geometry the GPU
sees is the geometry the rule rebuilds. For every case, side and binary32 position the page draws one fragment per position
through each program on the same GPU and backend: old = KinVolumeSculpt.shaderReplacement's text, bu = KinVolumeVrMasks.TEXT
with KinVolumeVrMasks.pack's numbers as uniforms; js = KinVolumeSculpt.contains at the position's double q (the existing
CPU/GPU contract difference, reported apart). The record is assembled as the approved boundary records are and judged by
o9_band.verify: pass = rule_pass AND 0 out-of-range (rule_pass itself requires a complete, consistent record, gl_error 0, the
R-001 fixture agreeing on both sides, every stored difference in-band, and the pinned shader texts).

Backend: KIN_BU_ANGLE=swiftshader (default; the CI backend) or d3d11 (reader-hardware evidence runs on Windows). With
KIN_BU_OUT set, the record and the verdict are written there. Assertions bind to rendered decisions and the rule's verdict,
never to product internals (D73).
"""
import hashlib, json, os, sys, unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
LITE = ROOT / 'worklist-v0' / 'hpacs-lite'
sys.path.insert(0, str(ROOT / 'tests'))
import o9_band  # noqa: E402

ANGLE = os.environ.get('KIN_BU_ANGLE', 'swiftshader')
ARGS = {'swiftshader': ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], 'd3d11': ['--use-angle=d3d11']}
RENDERER = {'swiftshader': 'SwiftShader', 'd3d11': 'Direct3D11'}
ORIGIN = 'https://bu-boundary.test/'

PAGE = r"""<!doctype html><meta charset="utf-8"><title>B-u boundary</title>
<script src="/lite/volume-sculpt.js"></script><script src="/lite/volume-vr-masks.js"></script>
<script>
// One fragment per query position: getColorForValue(vec4(0), posIS, vec3(0)) removed -> red 1. Both programs share the head,
// the main and the draw; only the getColorForValue replacement and its uniforms differ.
window.sweep=async cases=>{
  const S=window.KinVolumeSculpt,M=window.KinVolumeVrMasks,canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const gl=canvas.getContext('webgl2');if(!gl)throw Error('no WebGL2');
  const info=gl.getExtension('WEBGL_debug_renderer_info'),renderer=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  const VS='#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const HEAD='#version 300 es\nprecision highp float;\nprecision highp int;\nuniform highp sampler2D kinQ;\nout vec4 o;\n';
  const MAIN='\nvoid main(){ivec2 c=ivec2(gl_FragCoord.xy);vec3 pp=texelFetch(kinQ,c,0).xyz;vec4 r=getColorForValue(vec4(0.0),pp,vec3(0.0));o=vec4(r.x>0.5?0.0:1.0,0.0,0.0,1.0);}';
  const END='\n  return vec4(1.0);\n}';
  const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  const program=fragment=>{const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,VS));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.bindAttribLocation(p,0,'p');gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;};
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  function removed(fragment,setup,positions){
    const W=64,H=Math.ceil(positions.length/W),data=new Float32Array(W*H*4);positions.forEach((p,i)=>data.set(p,4*i));
    const input=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,input);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,W,H,0,gl.RGBA,gl.FLOAT,data);
    const target=gl.createTexture(),frame=gl.createFramebuffer();gl.bindTexture(gl.TEXTURE_2D,target);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);gl.viewport(0,0,W,H);
    const p=program(fragment);gl.useProgram(p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,input);gl.uniform1i(gl.getUniformLocation(p,'kinQ'),0);setup(p);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);const pixels=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.deleteProgram(p);gl.deleteTexture(input);gl.deleteTexture(target);gl.deleteFramebuffer(frame);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return positions.map((_,i)=>pixels[4*i]>127);
  }
  const qOf=(p,pos)=>[0,1].map(m=>p.base[m]+p.axes[0][m]*pos[0]+p.axes[1][m]*pos[1]+p.axes[2][m]*pos[2]);
  const texts=[],out=[];
  for(const c of cases)for(const side of ['Inside','Outside']){
    const op={region:c.region,projection:c.projection,side},old=S.shaderReplacement([op]).replacementValue,d=M.pack({sculpt:[op]});texts.push(old);
    const oldRemoved=removed(HEAD+old+END+MAIN,()=>{},c.pos);
    const buRemoved=removed(HEAD+M.TEXT+END+MAIN,p=>{const at=name=>gl.getUniformLocation(p,name);
      gl.uniform4iv(at('kinMeta'),d.meta);gl.uniform4fv(at('kinProj'),d.proj);gl.uniform4fv(at('kinBox'),d.box);gl.uniform4fv(at('kinEll'),d.ell);gl.uniform4fv(at('kinEdge'),d.edge);
      gl.uniform4iv(at('kinCross'),d.cross);gl.uniform4fv(at('kinVoi'),d.voi);gl.uniform2fv(at('kinVoiHalf'),d.voiHalf);gl.uniform4i(at('kinHead'),1,d.count,0,0);},c.pos);
    const js=c.pos.map(pos=>{const inside=S.contains(c.region,qOf(c.projection,pos));return side==='Inside'?inside:!inside;});
    out.push({side,old:oldRemoved,bu:buRemoved,js});
  }
  const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const glError=gl.getError();gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {renderer,results:out,gl_error:glError,shader_texts:{bu_sha256:await digest(M.TEXT),old_sha256:await digest(JSON.stringify(texts))}};
};
</script>"""


def record(cases, page_result):
    """The boundary record as the approved runs keep it (lab.js boundary()), from the rebuilt cases and the rendered decisions."""
    zero = lambda: {'cases': 0, 'decisions': 0, 'old_vs_bu': 0, 'old_vs_js': 0, 'bu_vs_js': 0, 'bu_adds': 0, 'bu_removes': 0}  # noqa: E731
    totals, out, results = {'all': zero(), 'fixture': zero(), 'dy-sweep': zero(), 'general': zero()}, [], iter(page_result['results'])
    for k in cases:
        for side in o9_band.SIDES:
            r = next(results)
            assert r['side'] == side and len(r['old']) == len(r['bu']) == len(r['js']) == len(k['pos'])
            mismatches, by_tag, t = [], {}, zero()
            t['cases'], t['decisions'] = 1, len(k['pos'])
            for i, pos in enumerate(k['pos']):
                tag = k['queries'][i][1]; b = by_tag.setdefault(o9_band.tag_key(tag), {'points': 0, 'old_vs_bu': 0, 'old_vs_js': 0, 'bu_vs_js': 0, 'bu_adds': 0, 'bu_removes': 0})
                old, bu, js = r['old'][i], r['bu'][i], r['js'][i]; b['points'] += 1
                ov, oj, bj = old != bu, old != js, bu != js
                if ov:
                    mismatches.append({'pos': list(pos), 'q_double': o9_band.q_of(k['projection'], list(pos)), 'tag': tag, 'old': old, 'bu': bu, 'js_double': js})
                for key, hit in (('old_vs_bu', ov), ('old_vs_js', oj), ('bu_vs_js', bj), ('bu_adds', not oj and bj), ('bu_removes', oj and not bj)):
                    b[key] += hit; t[key] += hit
            entry = {'group': k['group'], 'case': k['name'], 'side': side, 'region_kind': k['region']['kind'], 'projection': o9_band._proj_record(k), 'z': k['z'],
                     'points': len(k['pos']), 'removed_old': sum(r['old']), 'old_vs_bu_mismatches': len(mismatches), 'mismatch_tags': [g for g, x in by_tag.items() if x['old_vs_bu']],
                     'old_vs_js_double': t['old_vs_js'], 'bu_vs_js_double': t['bu_vs_js'], 'bu_adds': t['bu_adds'], 'bu_removes': t['bu_removes'], 'by_tag': by_tag, 'mismatches': mismatches}
            if k['group'] == 'fixture':
                entry.update(region=k['region'], q_given=o9_band.R001['q'], pos_float32=list(k['pos'][0]), q_double=o9_band.q_of(k['projection'], list(k['pos'][0])),
                             decision={'old': r['old'][0], 'bu': r['bu'][0], 'js_double': r['js'][0]})
            out.append(entry)
            for g in ('all', k['group']):
                for key in t:
                    totals[g][key] += t[key]
    fixture = [c for c in out if c['group'] == 'fixture']
    agree = len(fixture) == 2 and all(c['decision']['old'] == c['decision']['bu'] for c in fixture)
    failed = bool(totals['all']['old_vs_bu']) or bool(page_result['gl_error']) or not agree
    boundary = {'renderer': page_result['renderer'], 'cases': out, 'totals': totals, 'gl_error': page_result['gl_error'], 'shader_texts': page_result['shader_texts'],
                'fixture': {'case': fixture[0]['case'] if fixture else None, 'polygon': o9_band.R001['points'], 'bounds': o9_band.R001['bounds'], 'q': o9_band.R001['q'],
                            'sides': {c['side']: c['decision'] for c in fixture}, 'agree_both_sides': agree},
                'status': 'failed' if failed else 'ok'}
    # As the approved runs: a record with any old-vs-B-u difference has status failed and exit 1; the rule decides.
    return {'status': 'failed' if failed else 'complete', 'exit_code': 1 if failed else 0, 'angle': ANGLE, 'boundary': boundary}


class VolumeBuBoundaryTest(unittest.TestCase):
    def test_bu_t02_native_decisions_within_the_o9_rule(self):
        cases = o9_band.boundary_cases()
        payload = [{'region': k['region'], 'projection': k['projection'], 'pos': [list(p) for p in k['pos']]} for k in cases]

        def serve(route, request):
            name = request.url[len(ORIGIN):]
            if name in ('', 'index.html'):
                route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE)
            elif name in ('lite/volume-sculpt.js', 'lite/volume-vr-masks.js'):
                route.fulfill(status=200, content_type='application/javascript; charset=utf-8', body=(LITE / name.split('/', 1)[1]).read_bytes())
            else:
                route.fulfill(status=404, body='')
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=ARGS[ANGLE])
            try:
                page = browser.new_page(); page.route(ORIGIN + '**', serve); page.goto(ORIGIN)
                result = page.evaluate('cases=>sweep(cases)', payload); version = browser.version
            finally:
                browser.close()
        self.assertIn(RENDERER[ANGLE], result['renderer'], 'the decisions come from the named backend')
        rec = record(cases, result); rec['browser'] = version
        verdict = o9_band.verify([('bu-boundary-' + ANGLE, rec)], cases)
        out = os.environ.get('KIN_BU_OUT')
        if out:
            Path(out).mkdir(parents=True, exist_ok=True)
            for name, value in (('record.json', rec), ('verdict.json', verdict)):
                (Path(out) / name).write_text(json.dumps(value, indent=1) + '\n', encoding='utf-8')
        totals = rec['boundary']['totals']['all']
        print('BU-BOUNDARY ' + json.dumps({'angle': ANGLE, 'renderer': result['renderer'], 'decisions': totals['decisions'], 'old_vs_bu': totals['old_vs_bu'],
                                           'old_vs_js': totals['old_vs_js'], 'fixture_agrees': rec['boundary']['fixture']['agree_both_sides'],
                                           'verdict': verdict['totals'], 'rule_pass': verdict['rule_pass'], 'accepted': o9_band.accepted(verdict),
                                           'record_sha256': hashlib.sha256(json.dumps(rec, sort_keys=True).encode()).hexdigest()}), flush=True)
        print(o9_band.summary(verdict), flush=True)
        self.assertEqual(verdict['records'][0]['record_problems'], [])
        self.assertEqual(verdict['records'][0]['drift'], [], 'the rendered shader texts are the ones the rule models')
        self.assertTrue(rec['boundary']['fixture']['agree_both_sides'], 'R-001 fixture agrees on both sides')
        self.assertEqual(verdict['totals']['out_of_range'], 0)
        self.assertTrue(verdict['rule_pass'], 'every stored difference is in-band for the shader that produced it')
        self.assertTrue(o9_band.accepted(verdict))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
