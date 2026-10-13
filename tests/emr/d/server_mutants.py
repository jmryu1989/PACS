# coding: utf-8
"""TEST-D server mutants: each reverts one fix of Astra's findings - round 3 (DR2-01..08 on bfddc3d), round 4 (DR3-01..06
on a980357) - or removes the signing-time check Astra's own mutant AM10 removed, in a COPY of the source, and runs
tests/emr/d/server_test.cjs there. Round 5 part d adds Astra's own AR4-M08/AR4-M09 (e01ca30) as she wrote them and boundary
mutants of the evidence check and the workflow (R5-21..23) - several keep or move the checking text while its effect is
gone, which only a behaviour assertion can see. Equivalents (the same meaning written differently: notation, an if statement,
an extracted function, renamed names, other quotes, a `./` path) run the same way and must leave every case they name passing.

REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01..04 server cases (tests/emr/d/server_test.cjs).

A mutant counts as killed only when ALL of these hold (the rules of tests/emr/d/mutants.py):
  * the unmutated tree passes every server case (here, in the repository) and the unmutated copy passes every named case;
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure and
    code ERR_ASSERTION, and the mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.
An equivalent (EQUIVALENTS: the same meaning written differently) holds only when its anchor occurs exactly once, the child
exits 0 and the named case is reported `ok` with no crash marker.

The copy is a temporary root with what server_test.cjs reads (COPIED); api/node_modules is linked (a junction on Windows),
never copied, and the link is removed before the copy is. The source tree is never modified. stdlib only.
Usage: python -B tests/emr/d/server_mutants.py [--anchors-only] [--out PATH]; node from KIN_NODE or PATH.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import importlib.util

# Also load correctly when an independent review imports this driver by file path.
_record_spec = importlib.util.spec_from_file_location("emr_d_recorder", pathlib.Path(__file__).with_name("same_source.py"))
_record_module = importlib.util.module_from_spec(_record_spec)
_record_spec.loader.exec_module(_record_module)
recorded_execution = _record_module.recorded_execution

EVIDENCE = None
RUN_NUMBER = 0

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[3]
TEST = ROOT / "tests" / "emr" / "d" / "server_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")
# What server_test.cjs reads (emr/units/d.json ci.recorded_inputs "server-mutants"): the sources it compiles, the Prisma tree, the
# declaration, the workflow and the build-context files whose recorders its workflow case runs, the recorder, gate, runner
# and provisioning script, and tests/emr/d (live.py, device.cjs, same_source.py, ...). api/node_modules is linked.
COPIED = ["api/src", "api/prisma", "api/tsconfig.json", "api/nest-cli.json", "api/package.json", "api/package-lock.json", "api/start-production.sh",
          "api/.dockerignore", "api/Dockerfile", "emr/units/d.json", ".github/workflows/emr-d.yml", "tests/emr/d", "scripts/record-run.py",
          "scripts/emr-compose.py", "scripts/run-tests.py", "tests/live_test_gate.py"]

CASE = {
    "recovery": "TEST-D-04 atomic_retry server: a recovery releases the original it took over - after a transient store failure the next recovery commits it once, and an original still executing is never fenced",
    "allocation": "TEST-D-04 atomic_retry server: an allocation request keeps its identity - the same request before and after its first commit, at any unit revision; another meaning under its request ID is another request",
    "provide": "TEST-D-03 read_scope server: a response serving many units hands out no text before every provision naming exactly its versions is durable; a projection naming another author or recipient is refused",
    "adoption": "TEST-D-02 versions_and_sr server: a manual SR adoption counts only once its access event is durable - a ledger that cannot confirm it leaves it unconfirmed, and the same event confirms it later",
    "workflow": "EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, and each record hashes what its command consumes",
    "evidence": "EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA",
    "sources": "TEST-D-02 versions_and_sr server: what a finding incorporates is a fixed reference to its source's exact version - planned, signed, stored and recovered alike; a navigation link is none",
    "composed": "TEST-D-04 atomic_retry server: the runtime is composed once with every port and refuses a second composition",
    "signature": "TEST-D-04 atomic_retry server: an absent, altered, held, inactive, offline or foreign-request signature is refused before any commit",
    "own-result": "TEST-D-04 atomic_retry server: an allocation request answers its own committed result - after a later allocation, beside a parallel duplicate and after its reader's account changed; only another meaning under its request ID is refused, and nothing is answered where the study is not visible today",
    "consultation-result": "TEST-D-04 atomic_retry server: a consultation step resent after a later step answers that step's own result - its state, its text and who wrote it - through the durable provision of its own versions",
    "legacy": "TEST-D-03 read_scope server: a finding written before unit D answers neither its text nor its typed reasons; a signed finding's reasons leave only through their durable provision, and a refused revision carries none",
    "copies": "TEST-D-02 versions_and_sr server: copies of one source version - two marks of one saved comparison, its saved view and a mark on it - are one fixed reference, planned, signed, stored and recovered alike, every copy kept in the text",
    "stale": "TEST-D-04 atomic_retry server: a cited source gone before the commit keeps the stale-source refusal - in a recovery, for the original and every resend, and in a commit itself; storage that cannot be read leaves it pending for the next recovery",
}
# The image identity step's two lines (.github/workflows/emr-d.yml), as Astra's AR4-M09 anchors them.
IDENTITY_READ = "          revision=\"$(docker image inspect -f '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' \"kin-emrd-ci:$TARGET_SHA\")\""
IDENTITY_CHECK = "          test \"$revision\" = \"$TARGET_SHA\" || { echo \"image revision '$revision' is not $TARGET_SHA\"; exit 1; }"
MUTANTS = [
    {"id": "M-D-R3-DR2-01", "finding": "DR2-01", "title": "an adoption without a durable ledger receipt is reported confirmed",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    if (stored.fact.confirmed) return stored.fact;\n    await this.parts.ledger.append(",
     "new": "    return stored.fact;\n    await this.parts.ledger.append(",
     "case": CASE["adoption"], "expect": "DR2-01: an adoption the ledger cannot make durable is never reported confirmed"},
    {"id": "M-D-R3-DR2-02", "finding": "DR2-02", "title": "the served projection's author and recipient are not compared with the unit's",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    if (!parties) return;\n", "new": "    return;\n",
     "case": CASE["provide"], "expect": "DR2-02: a projection naming another author is refused"},
    {"id": "M-D-R3-DR2-03", "finding": "DR2-03", "title": "a response is sent after only its first provision is durable",
     "file": "api/src/emr-clinical/records.ts",
     "old": "  for (const event of events) receipts.push(", "new": "  for (const event of events.slice(0, 1)) receipts.push(",
     "case": CASE["provide"], "expect": "70 versions: two provisions (64 + 6), both durable before the text is sent"},
    {"id": "M-D-R3-DR2-04", "finding": "DR2-04", "title": "an allocation's request revision is compared with D's unit revision again",
     "file": "api/src/emr-clinical/contract.ts",
     "old": "text: 'none', revisionField: null, act: 'additional-entry',", "new": "text: 'none', revisionField: 'revision', act: 'additional-entry',",
     "case": CASE["allocation"], "expect": "DR2-04: an allocation carrying its row"},
    {"id": "M-D-R3-DR2-05", "finding": "DR2-05", "title": "a recovered original drops the sources its text incorporates",
     "file": "api/src/emr-clinical/store.ts",
     "old": "  try { attachments = await readClinicalSources(db, refs); }", "new": "  try { attachments = await readClinicalSources(db, []); }",
     "case": CASE["sources"], "expect": "DR2-05: the recovered original resolves the same sources again and commits"},
    {"id": "M-D-R3-DR2-06", "finding": "DR2-06", "title": "a recovery keeps the original it took over after it ends",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    } finally { this.store.release(acquired); }", "new": "    } finally { /* M-D-R3-DR2-06 */ }",
     "case": CASE["recovery"], "expect": "the failed recovery released the original it took over"},
    {'id': 'M-D-R3-DR2-07a',
     'finding': 'DR2-07',
     'title': 'the image is labelled and tagged with the workflow ref, not the checked-out source',
     'file': '.github/workflows/emr-d.yml',
     'old': '--build-arg "VCS_REF=${{ env.TARGET_SHA }}" -t "kin-emrd-ci:${{ env.TARGET_SHA }}"',
     'new': '--build-arg "VCS_REF=${{ github.sha }}" -t "kin-emrd-ci:${{ github.sha }}"',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'R5-22: the image of the requested source passes the identity check'},
    {"id": "M-D-R3-DR2-07b", "finding": "DR2-07", "title": "the image record leaves out a file the build copies",
     "file": ".github/workflows/emr-d.yml",
     "old": "--file api/tsconfig.json --file api/nest-cli.json -- docker build", "new": "--file api/nest-cli.json -- docker build",
     "case": CASE["workflow"], "expect": "the image record hashes api/tsconfig.json"},
    {"id": "M-D-R3-DR2-08", "finding": "DR2-08", "title": "a later binding replaces the port bound at server start",
     "file": "api/src/emr-clinical/services.ts",
     "old": "  if (bound) throw new ContractError('ClinicalRuntimeAlreadyComposed');\n", "new": "",
     # The composition needs A's adapters composed with D's sources first, which the sources case does in file order.
     "case": CASE["composed"], "with": [CASE["sources"]], "expect": "DR2-08: no later binding replaces the port bound at server start"},
    {"id": "M-D-R3-AM10", "finding": "AM10 (Astra's own mutant)", "title": "a signature whose signing time C cannot verify is accepted",
     "file": "api/src/emr-clinical/signing.ts",
     "old": "if (verified.time.status !== 'verified') refuse('SignatureTimeUnverified');",
     "new": "if (false && verified.time.status !== 'verified') refuse('SignatureTimeUnverified');",
     "case": CASE["signature"], "expect": "a reboot between anchor and signing"},
    {"id": "M-D-R4-DR3-01a", "finding": "DR3-01", "title": "an allocation request answers the allocation's current state, not its own result",
     "file": "api/src/reader-assignment.service.ts",
     "old": "    return this.answer(uid,c,b.revision+1,readerSub,result.projection);",
     "new": "    return this.run(c,async tx=>this.result(tx,await this.study(tx,uid,c,'share'),c));",
     "case": CASE["own-result"], "expect": "DR3-01: the earlier request answers its own result after a later allocation"},
    {"id": "M-D-R4-DR3-01b", "finding": "DR3-01", "title": "a registered request is admitted again (its reader's eligibility asked again) before its stored outcome",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    if (registered) return registered;", "new": "    if (false && registered) return registered;",
     "case": CASE["own-result"], "expect": "DR3-01: a registered request is answered without asking the identity provider again"},
    {"id": "M-D-R4-DR3-01c", "finding": "DR3-01 (same class: consultation write answers)",
     "title": "a consultation write answers the record's current state, not its own request's result (round 3's answer)",
     "file": "api/src/consultation.service.ts",
     "old": "        units:[{...this.provision(row,await readClinicalRows(tx,row.id)),scope:{sequences:[...new Set([1,receipt.revision])]}}],\n"
            "        send:async served=>({owner:[c.institution,c.sub],item:this.answered(row,served[0],receipt,result.projection)})});",
     "new": "        units:[this.provision(row,await readClinicalRows(tx,row.id))],\n"
            "        send:async served=>({owner:[c.institution,c.sub],item:this.item(row,served[0])})});",
     "case": CASE["consultation-result"], "expect": "DR3-01: the acceptance resent after the completion answers the acceptance"},
    {"id": "M-D-R4-DR3-02", "finding": "DR3-02", "title": "a revision written before unit D answers its typed reason",
     "file": "api/src/finding.service.ts",
     "old": "            if (!units.length) return answer(null, null);", "new": "            if (!units.length) return answer(row.reason, null);",
     "case": CASE["legacy"], "expect": "DR3-02: the summary of a revision written before unit D"},
    {"id": "M-D-R4-DR3-03", "finding": "DR3-03", "title": "every copy of one source version is cited again",
     "file": "api/src/emr-clinical/sources.ts",
     "old": "    if (loaded.has(sourceEventId(ref))) continue;\n", "new": "",
     "case": CASE["copies"], "expect": "DR3-03: two marks of one saved comparison cite that version once"},
    {"id": "M-D-R4-DR3-04a", "finding": "DR3-04", "title": "a recovery whose cited source is gone is sealed as an ordinary input error",
     "file": "api/src/emr-clinical/store.ts",
     "old": "      const code = error.code === 'ClinicalSourceMissing' ? 'ClinicalSourceMissing' : 'AttachmentRefused';",
     "new": "      const code = 'AttachmentRefused';",
     "case": CASE["stale"], "expect": "DR3-04: the recovery keeps the stale source as such"},
    {"id": "M-D-R4-DR3-04b", "finding": "DR3-04", "title": "a source that cannot be read now is settled as gone",
     "file": "api/src/emr-clinical/store.ts",
     "old": "    if (error instanceof ContractError && error.code !== 'ClinicalSourcesNotComposed') refuse('ClinicalSourceMissing');",
     "new": "    refuse('ClinicalSourceMissing');",
     "case": CASE["stale"], "expect": "DR3-04: a transient failure leaves the original pending"},
    {"id": "M-D-R4-DR3-04c", "finding": "DR3-04", "title": "a commit meeting a cited source that went after admission refuses it as a missing record",
     "file": "api/src/finding.service.ts",
     "old": "    await readClinicalSources(tx, v.attachments.map(citedSource));\n", "new": "",
     "case": CASE["stale"], "expect": "DR3-04: a commit whose cited source went after admission is refused as that stale source"},
    {"id": "M-D-R4-DR3-05a", "finding": "DR3-05", "title": "the server record no longer hashes the migrations its declaration case reads",
     "file": ".github/workflows/emr-d.yml",
     "old": "--run-dir tmp/emr-d-ci/server --cwd . --tree api/src --tree api/prisma --tree tests/emr/d",
     "new": "--run-dir tmp/emr-d-ci/server --cwd . --tree api/src --file api/prisma/schema.prisma --tree tests/emr/d",
     "case": CASE["workflow"], "expect": "the server record hashes api/prisma"},
    {"id": "M-D-R4-DR3-05b", "finding": "DR3-05", "title": "the R1 mutants record no longer hashes the lock that pins its compiler",
     "file": ".github/workflows/emr-d.yml",
     "old": "--file tests/emr/d/contract_test.cjs --file api/tsconfig.json --file api/package-lock.json -- python3 -B tests/emr/d/mutants.py",
     "new": "--file tests/emr/d/contract_test.cjs --file api/tsconfig.json -- python3 -B tests/emr/d/mutants.py",
     "case": CASE["workflow"], "expect": "the mutants record hashes api/package-lock.json"},
    {"id": "M-D-R4-DR3-05d", "finding": "DR3-05", "title": "the last step no longer checks that each record hashed its declared inputs",
     "file": "tests/emr/d/same_source.py",
     "old": "    for tree in sorted(trees | {normal(need) for need in needs}):",
     "new": "    for tree in sorted(trees):",
     "case": CASE["evidence"], "expect": "DR3-05: a record that did not hash a declared input fails the check"},
    {'id': 'M-D-R4-DR3-06',
     'finding': 'DR3-06',
     'title': 'the workflow case splits lines on whitespace (a parser of its own) instead of as the shell does',
     'file': 'tests/emr/d/server_test.cjs',
     'old': 'job[\\"line\\"]',
     'new': '\\" \\".join(job[\\"line\\"].split())',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'DR3-06: Bash recorder execution'},
    {"id": "AR4-M08", "finding": "DR4-06 (Astra's own mutant)", "title": "a record of another commit passes when only one of its heads differs",
     "file": "tests/emr/d/same_source.py",
     "old": "run.get(\"git_head_before\") != sha or run.get(\"git_head_after\") != sha",
     "new": "run.get(\"git_head_before\") != sha and run.get(\"git_head_after\") != sha",
     "case": CASE["workflow"], "expect": "a record of another commit fails the check"},
    {"id": "AR4-M09", "finding": "DR4-07 (Astra's own mutant)", "title": "the image identity step no longer compares the revision",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_CHECK, "new": "          : # revision comparison removed",
     "case": CASE["workflow"], "expect": "image identity must refuse a wrong image"},
    {'id': 'M-D-R5-21a',
     'finding': 'R5-21 / DR4-06',
     'title': "the last step no longer compares what a record hashed with TARGET_SHA's objects",
     'file': 'tests/emr/d/same_source.py',
     'old': '        elif digests[name] != before[name][1]:',
     'new': '        elif False:',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'D5D-01: record content differs while checkout restored'},
    {'id': 'M-D-R5-21c',
     'finding': 'R5-21 / DR4-06',
     'title': 'a file of TARGET_SHA a record did not hash (a removed migration) passes',
     'file': 'tests/emr/d/same_source.py',
     'old': '        bad.extend("%s: a file of %s in %s the record did not hash" % (name, sha, tree) for name in members '
            'if name not in before)',
     'new': '        pass',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'DR4-06: every migration entry removed from the server record'},
    {"id": "M-D-R5-21e", "finding": "R5-21", "title": "a log changed after the run passes",
     "file": "tests/emr/d/same_source.py",
     "old": "        elif not (folder / name).is_file() or file_sha256(folder / name) != item[\"sha256\"]:", "new": "        elif False:",
     "case": CASE["evidence"], "expect": "R5-21: a log changed after the run is refused"},
    {"id": "M-D-R5-21f", "finding": "R5-21", "title": "a declared step that did not run counts as a pass",
     "file": "tests/emr/d/same_source.py",
     "old": "        result.update(verdict=\"unrun\", problems=[\"no record: the step did not run\"])", "new": "        result.update(verdict=\"pass\")",
     "case": CASE["evidence"], "expect": "R5-21: a declared step that did not run is refused"},
    {"id": "M-D-R5-21g", "finding": "R5-21", "title": "a failing command counts as a pass",
     "file": "tests/emr/d/same_source.py",
     "old": "    if run[\"exit_code\"] != 0 or run[\"recorder_exit_code\"] != 0:", "new": "    if False:",
     "case": CASE["evidence"], "expect": "R5-21: a failing command is refused"},
    {'id': 'M-D-R5-21h',
     'finding': 'R5-21',
     'title': 'a skipped declared case counts as a pass',
     'file': 'tests/emr/d/same_source.py',
     'old': '        if sorted(cases["skipped"]) != sorted(section.get("skipped", [])):',
     'new': '        if False:',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'D5D-02: unexpected contract skip is refused'},
    {"id": "M-D-R5-21i", "finding": "R5-21", "title": "the declaration is read from the working tree, not from TARGET_SHA",
     "file": "tests/emr/d/same_source.py",
     "old": "        declaration = json.loads(commit.read(DECLARATION).decode(\"utf-8\"))",
     "new": "        declaration = json.loads(pathlib.Path(DECLARATION).read_text(encoding=\"utf-8\"))",
     "case": CASE["evidence"], "expect": "R5-21: a declaration weakened in the working tree is not the reference: the live record is not a pass"},
    {'id': 'M-D-R5-21j',
     'finding': 'R5-21',
     'title': 'an input the run produced (the image identity) is not bound to the file the live run consumed',
     'file': 'tests/emr/d/same_source.py',
     'old': '        if not pathlib.Path(name).is_file() or lf_sha256(pathlib.Path(name).read_bytes()) != before[name][1]:',
     'new': '        if False:',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'R5-21: the image identity changed after the live run consumed it: the refusal names tmp/emr-d-ci/image-identity.txt'},
    {"id": "M-D-R5-21k", "finding": "R5-21 / DR3-05", "title": "the declaration drops the migrations the live run's image applies",
     "file": "emr/units/d.json", "old": "\"live\": [\"emr/units/d.json\", \"tests/emr/d\", \"api/prisma/migrations\", ",
     "new": "\"live\": [\"emr/units/d.json\", \"tests/emr/d\", ",
     "case": CASE["workflow"], "expect": "R5-21: the live declaration names api/prisma/migrations"},
    {"id": "M-D-R5-21l", "finding": "R5-21 / DR3-05", "title": "the live record no longer hashes the migration tree",
     "file": ".github/workflows/emr-d.yml", "old": "--tree tests/emr/d --tree api/prisma/migrations --file emr/units/d.json --file scripts/emr-compose.py",
     "new": "--tree tests/emr/d --file emr/units/d.json --file scripts/emr-compose.py",
     "case": CASE["workflow"], "expect": "the live record hashes api/prisma/migrations"},
    {"id": "M-D-R5-22a", "finding": "R5-22 / DR4-07", "title": "the revision comparison stays written but no longer stops the run",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_CHECK, "new": IDENTITY_CHECK.replace("; exit 1; }", "; }"),
     "case": CASE["workflow"], "expect": "image identity must refuse a wrong image"},
    {"id": "M-D-R5-22b", "finding": "R5-22 / DR4-07", "title": "the revision is compared with the requested source itself",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_CHECK, "new": IDENTITY_CHECK.replace("test \"$revision\"", "test \"$TARGET_SHA\""),
     "case": CASE["workflow"], "expect": "image identity must refuse a wrong image"},
    {"id": "M-D-R5-22c", "finding": "R5-22 / DR4-07", "title": "the identity step reads a label the build never sets",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_READ, "new": IDENTITY_READ.replace("image.revision", "image.version"),
     "case": CASE["workflow"], "expect": "R5-22: the image of the requested source passes the identity check"},
    {"id": "M-D-R5-22d", "finding": "R5-22 / DR2-07", "title": "the image is built without the requested source as its revision",
     "file": ".github/workflows/emr-d.yml", "old": "--target production --build-arg \"VCS_REF=${{ env.TARGET_SHA }}\" -t",
     "new": "--target production -t",
     "case": CASE["workflow"], "expect": "R5-22: the image of the requested source passes the identity check"},
    {"id": "M-D-R5-22e", "finding": "R5-22", "title": "the checkout is compared with itself, not with TARGET_SHA",
     "file": ".github/workflows/emr-d.yml", "old": "run: test \"$(git rev-parse HEAD)\" = \"$TARGET_SHA\"",
     "new": "run: test \"$(git rev-parse HEAD)\" = \"$(git rev-parse HEAD)\"",
     "case": CASE["workflow"], "expect": "R5-22: a checkout of another commit than TARGET_SHA is refused"},
    {"id": "M-D-R5-22g", "finding": "R5-22 / R5-21", "title": "the last step accepts an image identity of another revision",
     "file": "tests/emr/d/same_source.py", "old": "IMAGE_ID.fullmatch(words[0]) and words[1] == sha)", "new": "IMAGE_ID.fullmatch(words[0]))",
     "case": CASE["evidence"], "expect": "R5-22: an image identity of another revision is refused"},
    {"id": "M-D-R5-23a", "finding": "R5-23 / DR4-07", "title": "the revision comparison kept word for word as the arguments of a no-op command",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_CHECK, "new": IDENTITY_CHECK.replace("          test ", "          : test ", 1),
     "case": CASE["workflow"], "expect": "image identity must refuse a wrong image"},
    {"id": "M-D-R5-23b", "finding": "R5-23 / R5-21", "title": "the before/after comparison kept word for word behind a condition that never holds",
     "file": "tests/emr/d/same_source.py", "old": "        elif before[name] != after[name]:", "new": "        elif False and before[name] != after[name]:",
     "case": CASE["evidence"], "expect": "DR4-06: a hash changed after the command is refused"},
    {'id': 'M-D-R4-DR3-05missing',
     'finding': 'DR3-05',
     'title': 'migration tree truly absent from server declaration',
     'file': 'emr/units/d.json',
     'old': '"server": ["api/src", "api/prisma", "api/prisma/migrations", ',
     'new': '"server": ["api/src", ',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'DR3-05: the server declaration names api/prisma/migrations'},
    {'id': 'M-D-D5D-01',
     'finding': 'D5D-01',
     'title': 'D5D-01: post-run change',
     'file': 'tests/emr/d/same_source.py',
     'old': '    for name in sorted(final_names):',
     'new': '    for name in []:',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'D5D-01: post-run change'},
    {'id': 'M-D-D5D-01-raw',
     'finding': 'D5D-01',
     'title': 'a false raw hash borrows the correct LF hash',
     'file': 'tests/emr/d/same_source.py',
     'old': '            if before[name][0] not in allowed:',
     'new': '            if False:',
     'case': CASE['evidence'],
     'expect': 'D5D-01: raw hash cannot borrow a valid LF hash'},
    {'id': 'M-D-D5D-02',
     'finding': 'D5D-02',
     'title': 'D5D-02: same count different contract cases',
     'file': 'tests/emr/d/same_source.py',
     'old': '        if names != sorted(section["cases"]):',
     'new': '        if False:',
     'case': 'EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their '
             'step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA',
     'expect': 'D5D-02: same count different contract cases'},
    {'id': 'M-D-D5D-03',
     'finding': 'D5D-03',
     'title': 'D5D-03: identity mismatch is refused before DB start',
     'file': 'tests/emr/d/live.py',
     'old': '    if inspected.get("Id") != words[0] or revision != target_sha:',
     'new': '    if False:',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-03: identity mismatch is refused before DB start'},
    {'id': 'M-D-D5D-04',
     'finding': 'D5D-04',
     'title': 'the image record hashes api/prisma',
     'file': '.github/workflows/emr-d.yml',
     'old': '--run-dir tmp/emr-d-ci/image --cwd . --tree api/src --tree api/prisma',
     'new': '--run-dir tmp/emr-d-ci/image --cwd . --tree api/src --file api/prisma/schema.prisma',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'the image record hashes api/prisma'},
    {'id': 'M-D-D5D-05',
     'finding': 'D5D-05',
     'title': 'the incremental compiler cache is re-enabled',
     'file': '.github/workflows/emr-d.yml',
     'old': '--incremental false',
     'new': '--incremental true',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-05: incremental cache is neither consumed nor written'},
    {'id': 'M-D-D5D-06',
     'finding': 'D5D-06',
     'title': 'a record of another commit fails the check',
     'file': '.github/workflows/emr-d.yml',
     'old': 'run: python3 -B tests/emr/d/same_source.py',
     'new': "run: 'true'",
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'a record of another commit fails the check'},
    {'id': 'M-D-D5D-06-condition',
     'finding': 'D5D-06',
     'title': 'D5D-06: final gate runs on failure',
     'file': '.github/workflows/emr-d.yml',
     'old': 'id: same-source\n        if: ${{ !cancelled() }}',
     'new': 'id: same-source\n        if: false',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-06: final gate runs on failure'},
    {'id': 'M-D-D5D-06-missing',
     'finding': 'D5D-06',
     'title': 'D5D-06: final gate exists',
     'file': '.github/workflows/emr-d.yml',
     'old': 'id: same-source',
     'new': 'id: obsolete-gate',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-06: final gate exists'},
    {'id': 'M-D-D5D-06-early',
     'finding': 'D5D-06',
     'title': 'D5D-06: final gate runs after every record',
     'file': '.github/workflows/emr-d.yml',
     'old': '      - name: API typecheck including api/src/emr-clinical\n'
            '        id: typecheck\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/typecheck --cwd . --tree api/src --file '
            'api/tsconfig.json --file api/package-lock.json --file api/prisma/schema.prisma -- node '
            'api/node_modules/typescript/bin/tsc --noEmit --incremental false --listFiles --extendedDiagnostics --pretty '
            'false -p api\n'
            '      - name: D contracts and C01-C56 model selection (C52 explicitly deferred to R2 DOM)\n'
            '        id: contract\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/contract --cwd . --tree '
            'api/src/emr-clinical --tree api/src/emr-contract --file tests/emr/d/contract_test.cjs --file '
            'api/tsconfig.json --file api/package-lock.json -- docker run --rm --network none --read-only --tmpfs /tmp -v '
            '"$PWD:/src:ro" -w /src node:22-alpine node --test --test-reporter=junit tests/emr/d/contract_test.cjs\n'
            '      - name: Retained 14 and invariant 12 mutants (contract models distinguished; M-D-06 is round 2)\n'
            '        id: mutants\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/mutants --cwd . --tree api/src/emr-clinical '
            '--tree api/src/emr-contract --file tests/emr/d/mutants.py --file tests/emr/d/same_source.py --file '
            'scripts/record-run.py --file tests/emr/d/contract_test.cjs --file api/tsconfig.json --file '
            'api/package-lock.json -- python3 -B tests/emr/d/mutants.py\n'
            "      - name: D server cases and the d.json declaration (TEST-D-01..04 pure halves, this workflow's source "
            'binding)\n'
            '        id: server\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/server --cwd . --tree api/src --tree '
            'api/prisma --tree tests/emr/d --file emr/units/d.json --file api/tsconfig.json --file api/nest-cli.json '
            '--file api/package.json --file api/package-lock.json --file api/start-production.sh --file api/.dockerignore '
            '--file api/Dockerfile --file .github/workflows/emr-d.yml --file scripts/record-run.py --file '
            'scripts/emr-compose.py --file scripts/run-tests.py --file tests/live_test_gate.py -- node --test '
            '--test-reporter=junit tests/emr/d/server_test.cjs\n'
            '      - name: Production API image of this commit\n'
            '        id: image\n'
            '        if: ${{ !cancelled() }}\n'
            '        timeout-minutes: 20\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/image --cwd . --tree api/src --tree '
            'api/prisma --file api/Dockerfile --file api/.dockerignore --file api/start-production.sh --file '
            'api/package.json --file api/package-lock.json --file api/tsconfig.json --file api/nest-cli.json -- docker '
            'build --target production --build-arg "VCS_REF=${{ env.TARGET_SHA }}" -t "kin-emrd-ci:${{ env.TARGET_SHA }}" '
            'api\n'
            '      - name: The image is of the requested source (its revision label is TARGET_SHA)\n'
            '        id: image-identity\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: |\n'
            '          revision="$(docker image inspect -f \'{{ index .Config.Labels "org.opencontainers.image.revision" '
            '}}\' "kin-emrd-ci:$TARGET_SHA")"\n'
            '          test "$revision" = "$TARGET_SHA" || { echo "image revision \'$revision\' is not $TARGET_SHA"; exit '
            '1; }\n'
            '          mkdir -p tmp/emr-d-ci\n'
            '          docker image inspect -f \'{{ .Id }} {{ index .Config.Labels "org.opencontainers.image.revision" '
            '}}\' "kin-emrd-ci:$TARGET_SHA" > tmp/emr-d-ci/image-identity.txt\n'
            '      - name: EMR-D live (EmrDLive) on an empty hosted daemon through scripts/run-tests.py\n'
            '        id: live\n'
            '        if: ${{ !cancelled() }}\n'
            '        timeout-minutes: 45\n'
            '        env:\n'
            '          KIN_EMR_D_IMAGE_IDENTITY: tmp/emr-d-ci/image-identity.txt\n'
            '          KIN_TEST_API_IMAGE: kin-emrd-ci:${{ env.TARGET_SHA }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/live --cwd . --tree tests/emr/d --tree '
            'api/prisma/migrations --file emr/units/d.json --file scripts/emr-compose.py --file scripts/run-tests.py '
            '--file tests/live_test_gate.py --file tmp/emr-d-ci/image-identity.txt -- python3 -B scripts/run-tests.py '
            '--module tests/emr/d/live.py --unit emr-d-ci-live --mode live --timeout 2700\n'
            '      - name: Collect the server mutant recorder from the same workflow run\n'
            '        if: ${{ !cancelled() }}\n'
            '        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n'
            '        with:\n'
            '          name: emr-d-server-mutants\n'
            '          path: tmp/emr-d-ci/\n'
            '      - name: Every record and the image are of TARGET_SHA, and each record hashed what its command consumes '
            '(source = image = evidence)\n'
            '        id: same-source\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 -B tests/emr/d/same_source.py\n',
     'new': '      - name: Every record and the image are of TARGET_SHA, and each record hashed what its command consumes '
            '(source = image = evidence)\n'
            '        id: same-source\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 -B tests/emr/d/same_source.py\n'
            '      - name: API typecheck including api/src/emr-clinical\n'
            '        id: typecheck\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/typecheck --cwd . --tree api/src --file '
            'api/tsconfig.json --file api/package-lock.json --file api/prisma/schema.prisma -- node '
            'api/node_modules/typescript/bin/tsc --noEmit --incremental false --listFiles --extendedDiagnostics --pretty '
            'false -p api\n'
            '      - name: D contracts and C01-C56 model selection (C52 explicitly deferred to R2 DOM)\n'
            '        id: contract\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/contract --cwd . --tree '
            'api/src/emr-clinical --tree api/src/emr-contract --file tests/emr/d/contract_test.cjs --file '
            'api/tsconfig.json --file api/package-lock.json -- docker run --rm --network none --read-only --tmpfs /tmp -v '
            '"$PWD:/src:ro" -w /src node:22-alpine node --test --test-reporter=junit tests/emr/d/contract_test.cjs\n'
            '      - name: Retained 14 and invariant 12 mutants (contract models distinguished; M-D-06 is round 2)\n'
            '        id: mutants\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/mutants --cwd . --tree api/src/emr-clinical '
            '--tree api/src/emr-contract --file tests/emr/d/mutants.py --file tests/emr/d/same_source.py --file '
            'scripts/record-run.py --file tests/emr/d/contract_test.cjs --file api/tsconfig.json --file '
            'api/package-lock.json -- python3 -B tests/emr/d/mutants.py\n'
            "      - name: D server cases and the d.json declaration (TEST-D-01..04 pure halves, this workflow's source "
            'binding)\n'
            '        id: server\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/server --cwd . --tree api/src --tree '
            'api/prisma --tree tests/emr/d --file emr/units/d.json --file api/tsconfig.json --file api/nest-cli.json '
            '--file api/package.json --file api/package-lock.json --file api/start-production.sh --file api/.dockerignore '
            '--file api/Dockerfile --file .github/workflows/emr-d.yml --file scripts/record-run.py --file '
            'scripts/emr-compose.py --file scripts/run-tests.py --file tests/live_test_gate.py -- node --test '
            '--test-reporter=junit tests/emr/d/server_test.cjs\n'
            '      - name: Production API image of this commit\n'
            '        id: image\n'
            '        if: ${{ !cancelled() }}\n'
            '        timeout-minutes: 20\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/image --cwd . --tree api/src --tree '
            'api/prisma --file api/Dockerfile --file api/.dockerignore --file api/start-production.sh --file '
            'api/package.json --file api/package-lock.json --file api/tsconfig.json --file api/nest-cli.json -- docker '
            'build --target production --build-arg "VCS_REF=${{ env.TARGET_SHA }}" -t "kin-emrd-ci:${{ env.TARGET_SHA }}" '
            'api\n'
            '      - name: The image is of the requested source (its revision label is TARGET_SHA)\n'
            '        id: image-identity\n'
            '        if: ${{ !cancelled() }}\n'
            '        run: |\n'
            '          revision="$(docker image inspect -f \'{{ index .Config.Labels "org.opencontainers.image.revision" '
            '}}\' "kin-emrd-ci:$TARGET_SHA")"\n'
            '          test "$revision" = "$TARGET_SHA" || { echo "image revision \'$revision\' is not $TARGET_SHA"; exit '
            '1; }\n'
            '          mkdir -p tmp/emr-d-ci\n'
            '          docker image inspect -f \'{{ .Id }} {{ index .Config.Labels "org.opencontainers.image.revision" '
            '}}\' "kin-emrd-ci:$TARGET_SHA" > tmp/emr-d-ci/image-identity.txt\n'
            '      - name: EMR-D live (EmrDLive) on an empty hosted daemon through scripts/run-tests.py\n'
            '        id: live\n'
            '        if: ${{ !cancelled() }}\n'
            '        timeout-minutes: 45\n'
            '        env:\n'
            '          KIN_EMR_D_IMAGE_IDENTITY: tmp/emr-d-ci/image-identity.txt\n'
            '          KIN_TEST_API_IMAGE: kin-emrd-ci:${{ env.TARGET_SHA }}\n'
            '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/live --cwd . --tree tests/emr/d --tree '
            'api/prisma/migrations --file emr/units/d.json --file scripts/emr-compose.py --file scripts/run-tests.py '
            '--file tests/live_test_gate.py --file tmp/emr-d-ci/image-identity.txt -- python3 -B scripts/run-tests.py '
            '--module tests/emr/d/live.py --unit emr-d-ci-live --mode live --timeout 2700\n'
            '      - name: Collect the server mutant recorder from the same workflow run\n'
            '        if: ${{ !cancelled() }}\n'
            '        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n'
            '        with:\n'
            '          name: emr-d-server-mutants\n'
            '          path: tmp/emr-d-ci/\n',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-06: final gate runs after every record'},
    {'id': 'M-D-D5D-07',
     'finding': 'D5D-07',
     'title': 'D5D-07: completed and interrupted raw streams survive',
     'file': 'tests/emr/d/same_source.py',
     'old': '    return code, stdout, stderr',
     'new': '    return code, "", ""',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-07: completed and interrupted raw streams survive'},
    {'id': 'M-D-D5D-08',
     'finding': 'D5D-08',
     'title': 'D5D-08: the child reports an actual typecheck',
     'file': '.github/workflows/emr-d.yml',
     'old': '-- node api/node_modules/typescript/bin/tsc --noEmit --incremental false --listFiles --extendedDiagnostics '
            '--pretty false -p api',
     'new': '-- python3 -c "pass"',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-08: the child reports an actual typecheck'},
    {'id': 'M-D-D5D-07-summary',
     'finding': 'D5D-07',
     'title': 'the completed mutant is not persisted before the next execution',
     'file': 'tests/emr/d/server_mutants.py',
     'old': '        summary["pending"].remove(mutant["id"])\n        save()',
     'new': '        summary["pending"].remove(mutant["id"])',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes',
     'expect': 'D5D-07: completed and interrupted raw streams survive'},
    {"id": "M-D-D5D-08-command", "finding": "D5D-08", "title": "a no-op borrows another command's TypeScript output",
     "file": "tests/emr/d/same_source.py", "old": "        if not valid_cli:", "new": "        if False:",
     "case": CASE["evidence"], "expect": "D5D-08: another command cannot borrow a TypeScript result"},
]

EQUIVALENTS = [
    {"id": "E-D-R4-DR3-06a", "finding": "DR3-06", "title": "the image's build argument and tag written as quoted concatenations",
     "file": ".github/workflows/emr-d.yml",
     "old": "--build-arg \"VCS_REF=${{ env.TARGET_SHA }}\" -t \"kin-emrd-ci:${{ env.TARGET_SHA }}\"",
     "new": "--build-arg VCS_REF=\"${{ env.TARGET_SHA }}\" -t 'kin-emrd-ci:'\"${{ env.TARGET_SHA }}\"",
     "case": CASE["workflow"], "with": [CASE["evidence"]]},
    {"id": "E-D-R4-DR3-06b", "finding": "DR3-06", "title": "the image record's inputs written with quoted parts, a backslash escape and single quotes",
     "file": ".github/workflows/emr-d.yml",
     "old": "--file api/Dockerfile --file api/.dockerignore --file api/start-production.sh",
     "new": "--file \"api\"/Dockerfile --file api\\/.dockerignore --file 'api/start-production.sh'",
     "case": CASE["workflow"], "with": [CASE["evidence"]]},
    {"id": "E-D-R5-22a", "finding": "R5-22 / R5-23", "title": "the revision comparison written as an if statement with [ ]",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_CHECK,
     "new": "          if [ \"$revision\" != \"$TARGET_SHA\" ]; then\n            echo \"image revision '$revision' is not $TARGET_SHA\"\n            exit 1\n          fi",
     "case": CASE["workflow"]},
    {"id": "E-D-R5-22b", "finding": "R5-22 / R5-23", "title": "the label read by an extracted shell function with --format and a compact template",
     "file": ".github/workflows/emr-d.yml", "old": IDENTITY_READ,
     "new": "          label() { docker image inspect --format '{{index .Config.Labels \"'\"$1\"'\"}}' \"kin-emrd-ci:$TARGET_SHA\"; }\n"
            "          revision=\"$(label org.opencontainers.image.revision)\"",
     "case": CASE["workflow"]},
    {"id": "E-D-R5-23a", "finding": "R5-23 / R5-21", "title": "the before/after comparison extracted into a nested helper with other names",
     "file": "tests/emr/d/same_source.py",
     "old": "    for name in sorted(set(before) | set(after)):\n"
            "        if name not in after:\n"
            "            bad.append(\"%s: gone or unhashed after the command\" % name)\n"
            "        elif name not in before:\n"
            "            bad.append(\"%s: appeared during the command\" % name)\n"
            "        elif before[name] != after[name]:\n"
            "            bad.append(\"%s: changed while the command ran\" % name)\n",
     "new": "    def drift(first, second):\n"
            "        for path in sorted(set(first) | set(second)):\n"
            "            if path not in second:\n"
            "                yield \"%s: gone or unhashed after the command\" % path\n"
            "            elif path not in first:\n"
            "                yield \"%s: appeared during the command\" % path\n"
            "            elif first[path] != second[path]:\n"
            "                yield \"%s: changed while the command ran\" % path\n"
            "    bad.extend(drift(before, after))\n",
     "case": CASE["evidence"], "with": [CASE["workflow"]]},
    {"id": "E-D-R5-23b", "finding": "R5-23", "title": "a helper renamed in its body and written with other quotes",
     "file": "tests/emr/d/same_source.py",
     "old": "def normal(name):\n    return posixpath.normpath(str(name).replace(\"\\\\\", \"/\"))\n",
     "new": "def normal(path_name):\n    return posixpath.normpath(str(path_name).replace('\\\\', '/'))\n",
     "case": CASE["evidence"], "with": [CASE["workflow"]]},
    {"id": "E-D-R5-23c", "finding": "R5-23 / DR3-06", "title": "the image recorder named by a ./ path and its run directory quoted",
     "file": ".github/workflows/emr-d.yml", "old": "run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/image ",
     "new": "run: python3 ./scripts/record-run.py --run-dir \"tmp/emr-d-ci/image\" ",
     "case": CASE["workflow"], "with": [CASE["evidence"]]},
    {'id': 'E-D-R4-DR3-05c',
     'finding': 'DR3-05',
     'title': 'redundant migration declaration removed; api/prisma includes its whole subtree',
     'file': 'emr/units/d.json',
     'old': '      "server": ["api/src", "api/prisma", "api/prisma/migrations", ',
     'new': '      "server": ["api/src", "api/prisma", ',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
    {'id': 'AE5D-01',
     'finding': 'D5D-04/06',
     'title': 'equivalent AE5D-01',
     'file': '.github/workflows/emr-d.yml',
     'old': '        run: python3 scripts/record-run.py --run-dir tmp/emr-d-ci/image --cwd . --tree api/src --tree '
            'api/prisma --file api/Dockerfile --file api/.dockerignore --file api/start-production.sh --file '
            'api/package.json --file api/package-lock.json --file api/tsconfig.json --file api/nest-cli.json -- docker '
            'build --target production --build-arg "VCS_REF=${{ env.TARGET_SHA }}" -t "kin-emrd-ci:${{ env.TARGET_SHA }}" '
            'api',
     'new': '        run: |\n'
            '          python3 scripts/record-run.py --run-dir tmp/emr-d-ci/image \\\n'
            '          --cwd . --tree api/src --tree api/prisma --file api/Dockerfile --file api/.dockerignore --file '
            'api/start-production.sh --file api/package.json --file api/package-lock.json --file api/tsconfig.json --file '
            'api/nest-cli.json -- docker build --target production --build-arg "VCS_REF=${{ env.TARGET_SHA }}" -t '
            '"kin-emrd-ci:${{ env.TARGET_SHA }}" api',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
    {'id': 'AE5D-02',
     'finding': 'D5D-04/06',
     'title': 'equivalent AE5D-02',
     'file': '.github/workflows/emr-d.yml',
     'old': '        run: test "$(git rev-parse HEAD)" = "$TARGET_SHA"',
     'new': '        run: test "$(git rev-parse HEAD)" = "$TARGET_SHA" # GITHUB_SHA is not used',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
    {'id': 'AE5D-03',
     'finding': 'D5D-04/06',
     'title': 'equivalent AE5D-03',
     'file': 'api/Dockerfile',
     'old': 'COPY package.json package-lock.json ./',
     'new': 'COPY ["package.json", "package-lock.json", "./"]',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
    {'id': 'AE5D-04',
     'finding': 'D5D-04/06',
     'title': 'equivalent AE5D-04',
     'file': '.github/workflows/emr-d.yml',
     'old': '          revision="$(docker image inspect',
     'new': '          # GITHUB_SHA is deliberately not the source\n          revision="$(docker image inspect',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
    {'id': 'E-D-D5D-06',
     'finding': 'D5D-04/06',
     'title': 'equivalent E-D-D5D-06',
     'file': '.github/workflows/emr-d.yml',
     'old': '        run: python3 -B tests/emr/d/same_source.py',
     'new': '        run: |\n          check_source() { python3 -B tests/emr/d/same_source.py; }\n          check_source',
     'case': 'EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, '
             'and each record hashes what its command consumes'},
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    return [f"{m['id']}: anchor occurs {read_lf(ROOT / m['file']).count(m['old'])} times in {m['file']}"
            for m in MUTANTS + EQUIVALENTS if read_lf(ROOT / m["file"]).count(m["old"]) != 1]


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def link(target, at):
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(target), str(at))
    else:
        os.symlink(target, at, target_is_directory=True)


class Copy:
    """A temporary root holding a copy of what server_test.cjs reads, with api/node_modules linked."""

    def __init__(self, mutant=None):
        self.mutant, self.hashes = mutant, {}

    def __enter__(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="emr-d-r3-mutant-"))
        for item in COPIED:
            source, target = ROOT / item, self.root / item
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copyfile(source, target)
        self.modules = self.root / "api" / "node_modules"
        link(ROOT / "api" / "node_modules", self.modules)
        if self.mutant:
            target = self.root / self.mutant["file"]
            text = read_lf(target)
            mutated = text.replace(self.mutant["old"], self.mutant["new"], 1)
            target.write_bytes(mutated.encode("utf-8"))
            self.hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
        return self

    def __exit__(self, *_):
        # The link goes first and alone: removing it never touches the linked node_modules.
        if os.name == "nt":
            os.rmdir(self.modules)
        else:
            os.unlink(self.modules)
        shutil.rmtree(self.root)


def run(node, test, cases=None):
    env = {**os.environ, "NODE_OPTIONS": ""}
    env.pop("KIN_EMR_D_ROOT", None)
    env.pop("KIN_EMR_D_API_SRC", None)
    selection = ["--test-name-pattern=^(" + "|".join(re.escape(case) for case in cases) + ")$"] if cases else []
    global RUN_NUMBER, EVIDENCE
    if EVIDENCE is None:
        # Direct review probes use run() without main(); retain their logs outside disposable copies too.
        EVIDENCE = pathlib.Path(tempfile.mkdtemp(prefix="emr-d-recorded-probe-"))
    RUN_NUMBER += 1
    folder = EVIDENCE / ("execution-%03d" % RUN_NUMBER)
    result = recorded_execution([node, "--test", "--test-reporter=tap", *selection, str(test)], test.parents[3], env, folder, 900, cases or json.loads((ROOT / "emr/units/d.json").read_text())["cases"]["server"]["cases"])
    collected = tap_cases(result[1])
    (folder / "selection.json").write_text(json.dumps({"selected": cases or json.loads((ROOT / "emr/units/d.json").read_text())["cases"]["server"]["cases"], "collected": list(collected),
        "states": {n: {"status": row[0], "skip": row[1]} for n, row in collected.items()}}, indent=2), encoding="utf-8")
    return result


def run_saved(*args, **kwargs):
    """Retain exceptional tool failures as failed executions, with the partial streams."""
    try:
        return run(*args, **kwargs)
    except Exception as exc:
        folder = EVIDENCE / ('interruption-%03d' % RUN_NUMBER)
        folder.mkdir(parents=True, exist_ok=True)
        def decoded(value):
            return value.decode('utf-8', 'replace') if isinstance(value, bytes) else value or ''
        out, err = decoded(getattr(exc, 'stdout', '')), decoded(getattr(exc, 'stderr', ''))
        (folder / 'stdout.log').write_text(out, encoding='utf-8')
        (folder / 'stderr.log').write_text(err, encoding='utf-8')
        (folder / 'execution.json').write_text(json.dumps({'status': 'failed', 'exception': type(exc).__name__,
            'message': str(exc), 'exit': None, 'selected': args[-1] if len(args) > 2 else 'baseline', 'collected': list(tap_cases(out))}), encoding='utf-8')
        return 124, out, err


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    lines, cases, i = stdout.splitlines(), {}, 0
    while i < len(lines):
        match = TAP_LINE.match(lines[i])
        i += 1
        if not match:
            continue
        block = []
        if i < len(lines) and lines[i].strip() == "---":
            # The block ends at '...' on the indentation of its own '---': an assertion diff inside it may hold a deeper
            # "..." line (node elides unchanged lines with one), which is part of the block, not its end.
            end = lines[i][:len(lines[i]) - len(lines[i].lstrip())] + "..."
            i += 1
            while i < len(lines) and lines[i].rstrip() != end:
                block.append(lines[i])
                i += 1
            i += 1
        if match.group(3) in cases:
            raise ValueError("duplicate TAP case: " + match.group(3))
        cases[match.group(3)] = (match.group(1), match.group(4), block)
    return cases


def judge(mutant, code, stdout, stderr):
    entry = tap_cases(stdout).get(mutant["case"])
    block = "\n".join(entry[2]) if entry else ""
    reasons = []
    if code == 0:
        reasons.append("child exited 0")
    if entry is None:
        reasons.append("named case not reported")
    elif entry[0] != "not ok" or entry[1]:
        reasons.append(f"named case reported {entry[0]} {entry[1] or ''}".strip())
    if "failureType: 'testCodeFailure'" not in block:
        reasons.append("no testCodeFailure in the case block")
    if "code: 'ERR_ASSERTION'" not in block:
        reasons.append("no ERR_ASSERTION in the case block")
    if mutant["expect"] not in block:
        reasons.append("expect text not in the case block")
    crash = [marker for marker in CRASH_MARKERS if marker in stdout or marker in stderr]
    if crash:
        reasons.append("crash markers: " + ", ".join(crash))
    return {"killed": not reasons, "reasons": reasons, "case_block": entry[2] if entry else []}


def judge_equivalent(equivalent, code, stdout, stderr):
    """An equivalent holds when every case it names passes on the copy written differently (and nothing crashed)."""
    cases, reasons, blocks = tap_cases(stdout), [], {}
    if code != 0:
        reasons.append("child exited %d" % code)
    for name in [equivalent["case"], *equivalent.get("with", [])]:
        entry = cases.get(name)
        blocks[name] = entry[2] if entry else []
        if entry is None:
            reasons.append("named case not reported: " + name)
        elif entry[0] != "ok" or entry[1]:
            reasons.append(f"named case reported {entry[0]} {entry[1] or ''}: {name}")
    crash = [marker for marker in CRASH_MARKERS if marker in stdout or marker in stderr]
    if crash:
        reasons.append("crash markers: " + ", ".join(crash))
    return {"holds": not reasons, "reasons": reasons, "case_blocks": blocks}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--anchors-only", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()
    global EVIDENCE
    EVIDENCE = pathlib.Path(args.out).resolve().with_suffix('.runs') if args.out else ROOT / 'tmp/emr-d-ci/server_mutants-executions'
    EVIDENCE.mkdir(parents=True, exist_ok=False)
    def save():
        destination = pathlib.Path(args.out) if args.out else EVIDENCE / 'summary.json'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    problems = check_anchors()
    summary = {"sources": {m["file"]: sha((ROOT / m["file"]).read_bytes()) for m in MUTANTS + EQUIVALENTS}, "anchors": problems or "ok",
               "baseline": None, "control": None, "mutants": [], "equivalents": []}
    summary["pending"] = ["baseline", "control", *[m["id"] for m in MUTANTS], *[e["id"] for e in EQUIVALENTS]]
    save()
    if problems or args.anchors_only:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1 if problems else 0
    node = node_binary()
    summary["node"] = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    code, stdout, stderr = run_saved(node, TEST)
    cases = tap_cases(stdout)
    failing = sorted(name for name, (status, skip, _) in cases.items() if status != "ok" or skip)
    summary["baseline"] = {"exit": code, "collected": list(cases), "not_passing": failing, "stdout": stdout, "stderr": stderr}
    summary["pending"].remove("baseline")
    save()
    if code or failing:
        return 1
    named = sorted({m["case"] for m in MUTANTS} | {c for e in EQUIVALENTS for c in [e["case"], *e.get("with", [])]})
    with Copy() as copy:
        code2, stdout2, stderr2 = run_saved(node, copy.root / "tests/emr/d/server_test.cjs", named)
    control = tap_cases(stdout2)
    summary["control"] = {"exit": code2, "stdout": stdout2, "stderr": stderr2, "collected": list(control), "passed": sorted(n for n, (s, k, _) in control.items() if s == "ok" and not k)}
    summary["pending"].remove("control")
    save()
    if code or failing or code2 or sorted(summary["control"]["passed"]) != named:
        summary["baseline"]["stderr_tail"], summary["control"]["stderr_tail"] = stderr[-2000:], stderr2[-2000:]
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1
    for mutant in MUTANTS:
        with Copy(mutant) as copy:
            code, stdout, stderr = run_saved(node, copy.root / "tests/emr/d/server_test.cjs", [mutant["case"], *mutant.get("with", [])])
        summary["mutants"].append({**{k: mutant[k] for k in ("id", "finding", "title", "file", "case", "expect")}, "exit": code,
                                   **copy.hashes, **judge(mutant, code, stdout, stderr), "stdout": stdout, "stderr": stderr})
        summary["pending"].remove(mutant["id"])
        save()
        if code == 124:
            return 1
    for equivalent in EQUIVALENTS:
        with Copy(equivalent) as copy:
            code, stdout, stderr = run_saved(node, copy.root / "tests/emr/d/server_test.cjs", [equivalent["case"], *equivalent.get("with", [])])
        summary["equivalents"].append({**{k: equivalent[k] for k in ("id", "finding", "title", "file", "case")}, "with": equivalent.get("with", []), "exit": code,
                                       **copy.hashes, **judge_equivalent(equivalent, code, stdout, stderr), "stdout": stdout, "stderr": stderr})
        summary["pending"].remove(equivalent["id"])
        save()
        if code == 124:
            return 1
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS),
                         "equivalents_holding": sum(e["holds"] for e in summary["equivalents"]), "equivalents": len(EQUIVALENTS)}
    save()
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if all(m["killed"] for m in summary["mutants"]) and all(e["holds"] for e in summary["equivalents"]) else 1


if __name__ == "__main__":
    sys.exit(main())
