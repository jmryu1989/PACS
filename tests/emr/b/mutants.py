"""B2R retained behavioral negative controls, copied source only.

The PG schema/transaction/failure red-controls run inside the real PG fixture.
Removed external-engine controls and replacements are in b.json. A build error,
missing selector or setup failure is never a behavioral kill. Source anchors
locate mutations only; the unchanged boundary assertions determine the result.
"""
from __future__ import annotations
import argparse,hashlib,io,json,os,re,shutil,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
DECLARATION=ROOT/'emr/units/b.json'
MUTANTS = {'M04': ('body bytes leave before the durable receipt (and with no receipt at all)',
         [('api/src/emr-runtime/contract.ts',
           '  return provideAfterDurableEvent(store, input, receipt => {\n'
           "    if (!isDurableReceipt(receipt)) refuse('DurableReceiptRefused');\n"
           '    return sendBody(receipt);\n'
           '  });\n',
           '  const early = sendBody({ eventId: input.eventId, durableAt: new Date().toISOString() });\n'
           '  try { await provideAfterDurableEvent(store, input, async receipt => receipt); } catch { /* '
           'sent anyway */ }\n'
           '  return early;\n')]),
 'M06': ('one display name joins two verified subjects into one member',
         [('api/src/emr-runtime/contract.ts',
           '  const id = string(await resolve(claims.issuer, claims.subject));\n',
           '  const id = string(await resolve(claims.issuer, claims.displayName ?? claims.subject));\n')]),
 'M07': ('an audit link ID or a session reference passes as a credential',
         [('api/src/emr-runtime/contract.ts',
           '/^(audit|authref):/i.test(value.trim())',
           '/^(?!)/.test(value.trim())')]),
 'M08': ('a forwarded address header is believed from any peer',
         [('api/src/emr-runtime/contract.ts',
           'if (!peer || !trustedPeers.has(peer) || typeof real',
           'if (!peer || typeof real')]),
 'M14': ('a declared live case missing from (or added to) its test file is accepted',
         [('scripts/emr-compose.py', '    if live != expected_live:\n', '    if live is None:\n')]),
 'M17': ('native clinical directions get only five years',
         [('api/src/emr-contract/classification.ts',
           "original decision, including a code-only direction', clinical, chart)",
           "original decision, including a code-only direction', clinical, images)")]),
 'M18': ('registration with no original direction is accepted',
         [('api/src/emr-contract/classification.ts',
           "  if (r.objectKind === 'registration' && r.directionSourceRef === null && r.origin !== "
           "'migrated') refuse('DirectionSourceRequired');\n",
           '')]),
 'M19': ('a retransmission resets the first local receipt clock',
         [('api/src/emr-contract/lawful-defaults.ts',
           ' || before.firstReceivedAt !== after.firstReceivedAt',
           '')]),
 'M20': ('unanswered review silently ends on the internal deadline',
         [('api/src/emr-contract/lawful-defaults.ts',
           "if (at >= p.finalDecisionDueAt) return 'superior-decision-overdue';",
           "if (at >= p.finalDecisionDueAt) return 'clear';")]),
 'M21': ('a claim end timestamp needs no actual ending evidence',
         [('api/src/emr-contract/lawful-defaults.ts', '    string(d.endingEventId);\n', '')]),
 'M22': ('a changed seed is still treated as verified synthetic',
         [('api/src/emr-contract/classification.ts', 's.originalSha256 !== s.observedSha256 || ', '')]),
 'M23': ('a subsequent event can drop an inherited original duty',
         [('api/src/emr-contract/lawful-defaults.ts',
           'before.inherited.some(d => !after.inherited.some(n => JSON.stringify(d) === JSON.stringify(n))) '
           '||',
           'false ||'),
          ('api/src/emr-contract/lawful-defaults.ts',
           "before.feed?.roles.some(role => role !== 'worklist-copy' && !after.feed?.roles.includes(role))",
           'false')]),
 'M24': ('a new clinical version needs no link to the prior preserved version',
         [('api/src/emr-runtime/contract.ts',
           '    if (previous.event.versionId !== e.versionId && (e.predecessor?.recordId !== '
           'previous.recordId ||\n'
           '        e.predecessor?.partId !== previous.event.versionId || e.predecessor?.sha256 !== '
           "previous.event.sha256)) refuse('OrderHistoryIncomplete');\n",
           '')]),
 'M39': ("head-lock waiters acquire every pool connection ahead of a committed request's verification",
         [('api/src/emr-runtime/admission.ts', 'if (pool.active >= capacity)', 'if (false)')]),
 'M40': ('append lanes consume the verification reserve',
         [('api/src/emr-runtime/limits.ts',
           'export const EMR_VERIFY_RESERVE = 2;',
           'export const EMR_VERIFY_RESERVE = 0;')])}

def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, *, cwd, env=None, timeout, log):
    started = time.monotonic()
    with open(log, "wb") as out:
        try:
            code = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            code = 124
    return code, round(time.monotonic() - started, 1)


def make_copy(target, worktree=False, source_manifest=None):
    """The committed checkout (HEAD) as files, with this checkout's installed api/node_modules linked in."""
    if source_manifest:
        # A Linux copy need not carry the commander's Windows Git metadata.
        # Copy only the explicitly hash-bound source inventory; reject drift.
        manifest = json.loads(Path(source_manifest).read_text(encoding="utf-8"))
        head = manifest["base_head"]
        for name, expected in manifest["files"].items():
            origin, destination = ROOT / name, target / name
            if (Path(name).is_absolute() or '..' in Path(name).parts or
                    not destination.resolve().is_relative_to(target.resolve()) or
                    not origin.resolve().is_relative_to(ROOT.resolve()) or sha256(origin) != expected):
                raise RuntimeError("source manifest mismatch: " + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, destination)
        (target / "mutant-inputs.json").write_text(json.dumps(manifest["files"], sort_keys=True), encoding="utf-8")
    else:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
        archive = subprocess.run(["git", "archive", "--format=tar", head], cwd=ROOT, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(target, filter="data") if sys.version_info >= (3, 12) else tar.extractall(target)
    if worktree and not source_manifest:
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
        declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))
        tracked = sorted(set(filter(None, tracked)) | {name for group in declaration["owned_paths"].values() for name in group})
        for name in filter(None, tracked):
            origin, destination = ROOT / name, target / name
            if origin.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(origin, destination)
            elif destination.exists():
                destination.unlink()
        (target / "mutant-inputs.json").write_text(json.dumps({name: sha256(ROOT / name) for name in tracked if name and (ROOT / name).is_file()}, sort_keys=True), encoding="utf-8")
    modules = ROOT / "api" / "node_modules"
    if not modules.is_dir():
        raise SystemExit("api/node_modules is required (npm ci --prefix api)")
    link = target / "api" / "node_modules"
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(modules.resolve())], check=True, capture_output=True)
    else:
        link.symlink_to(modules.resolve(), target_is_directory=True)
    return head, link


def unlink_modules(link):
    if os.name == "nt":
        os.rmdir(link)  # Remove this verified junction only, never its shared target tree.
    else:
        link.unlink()


def apply(copy, changes):
    """Apply every change of one mutant; returns [(path, original bytes, hashes)]. Line endings follow the file."""
    applied = []
    for path, before, after in changes:
        file = copy / path
        raw = file.read_bytes()
        text = raw.decode("utf-8")
        crlf = "\r\n" in text
        old, new = (before.replace("\n", "\r\n"), after.replace("\n", "\r\n")) if crlf else (before, after)
        if text.count(old) != 1:
            raise RuntimeError("mutant anchor not found exactly once: " + path)
        previous = next((item for item in applied if item["path"] == path), None)
        file.write_bytes(text.replace(old, new).encode("utf-8"))
        if previous is None:
            applied.append({"path": path, "original": raw, "before_sha256": hashlib.sha256(raw).hexdigest()})
    for item in applied:
        item["mutated_sha256"] = sha256(copy / item["path"])
    return applied


def restore(copy, applied):
    for item in applied:
        (copy / item["path"]).write_bytes(item["original"])
        item["restored_sha256"] = sha256(copy / item["path"])
        if item["restored_sha256"] != item["before_sha256"]:
            raise RuntimeError("restore differs: " + item["path"])
        del item["original"]


def contract_verdict(text, cases, code):
    blocks = re.findall(r"^not ok \d+ - ((?:C|POOL-)\d+) [^\n]*\n(.*?)(?=^# Subtest:|^ok |^not ok |^1\.\.|\Z)", text, re.M | re.S)
    failed = {case for case, details in blocks if case in cases and re.search(r"code: ['\"]?ERR_ASSERTION\b", details)}
    harness = any(case in cases and not re.search(r"code: ['\"]?ERR_ASSERTION\b", details) for case, details in blocks)
    passed = {case for case in cases if re.search(r"^ok \d+ - " + case + r" ", text, re.M)}
    return {"failed": sorted(failed), "passed": sorted(passed), "harness_errors": harness,
            "killed": code != 0 and failed == set(cases) and not harness}


def self_test():
    import unittest
    class Verdict(unittest.TestCase):
        def test_only_assertion_with_exact_case_is_a_kill(self):
            prefix="not ok 1 - C05 receipt boundary\n  ---\n  code: "
            for code,expected in [('ERR_ASSERTION',True),('ReferenceError',False)]:
                self.assertEqual(contract_verdict(prefix+"'"+code+"'\n1..1\n",['C05'],1)['killed'],expected)
            self.assertFalse(contract_verdict(prefix+"'ERR_ASSERTION'\n1..1\n",['C01'],1)['killed'])
            self.assertFalse(contract_verdict(prefix+"'ERR_ASSERTION'\n1..1\n",['C05'],0)['killed'])
            self.assertFalse(contract_verdict('not ok 1 - test file\n',['C05'],1)['killed'])
        def test_pool_assertion_is_not_a_setup_error(self):
            text="not ok 1 - POOL-03 connection reserve\n  code: 'ERR_ASSERTION'\n1..1\n"
            self.assertTrue(contract_verdict(text,['POOL-03'],1)['killed'])
    return 0 if unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Verdict)).wasSuccessful() else 1


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path);parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--only');parser.add_argument('--worktree',action='store_true')
    parser.add_argument('--source-manifest',type=Path)
    parser.add_argument('--contract-only',action='store_true',help='Compatibility: all controls here use pure boundaries')
    args=parser.parse_args(argv)
    if args.self_test:return self_test()
    if args.out is None:parser.error('--out is required')
    declaration=json.loads(DECLARATION.read_text(encoding='utf-8'))
    declared={m['id']:m for m in declaration['mutants']}
    if set(declared)!=set(MUTANTS):raise RuntimeError('Declaration differs from retained mutant driver')
    chosen=[m for m in declared if not args.only or m in args.only.split(',')]
    if not chosen or (args.only and set(args.only.split(','))-set(declared)):raise ValueError('Unknown/empty selection')
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=False)
    env={**os.environ,'KIN_EMR_PYTHON':sys.executable,'PYTHONIOENCODING':'utf-8'}
    rows=[]
    with tempfile.TemporaryDirectory(prefix='source-',dir=out) as folder:
        copy=Path(folder);head,link=make_copy(copy,args.worktree,args.source_manifest)
        try:
            if (copy/'mutant-inputs.json').exists():shutil.copyfile(copy/'mutant-inputs.json',out/'mutant-inputs.json')
            # Every selected mutant gets an unmodified behavior control for its
            # exact cases, and a restored-source control after the mutation.
            for name in chosen:
                cases=declared[name]['kill'];file='tests/emr/b/client_pool_test.cjs' if name in ('M39','M40') else 'tests/emr/b/contract_test.cjs'
                command=['node','--test','--test-concurrency=1','--test-reporter=tap','--test-name-pattern=^('+'|'.join(cases)+') ',file]
                baseline_code,_=run(command,cwd=copy,env=env,timeout=900,log=out/(name+'-before.log'))
                baseline_text=(out/(name+'-before.log')).read_text(encoding='utf-8',errors='replace')
                baseline=contract_verdict(baseline_text,cases,baseline_code)
                if baseline_code or set(baseline['passed'])!=set(cases):raise RuntimeError(name+' healthy behavior control failed')
                expected,changes=MUTANTS[name];applied=apply(copy,changes)
                try:
                    code,seconds=run(command,cwd=copy,env=env,timeout=900,log=out/(name+'-red.log'))
                    verdict=contract_verdict((out/(name+'-red.log')).read_text(encoding='utf-8',errors='replace'),cases,code)
                finally:restore(copy,applied)
                green_code,_=run(command,cwd=copy,env=env,timeout=900,log=out/(name+'-green.log'))
                green=contract_verdict((out/(name+'-green.log')).read_text(encoding='utf-8',errors='replace'),cases,green_code)
                row=dict(id=name,head_sha=head,expected_failure=expected,files=applied,cases=cases,exit=code,seconds=seconds,
                         verdict=verdict,green=green_code==0 and set(green['passed'])==set(cases))
                row['killed']=verdict['killed'] and row['green'];rows.append(row)
                (out/'mutants.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
                print(name+' killed='+str(row['killed']),flush=True)
        finally:unlink_modules(link)
    return 0 if rows and all(r['killed'] for r in rows) else 1


if __name__=='__main__':sys.exit(main())
