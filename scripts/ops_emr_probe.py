#!/usr/bin/env python3
"""One-shot EMR ledger probe of the EMR-introduction release (INTERIM-RELEASE-TOOLS item 7, plan L-10 / TEST-IR-06.6).

B1 has no HTTP route that appends to the access ledger and the Nest AppModule does not assemble the ledger, so a 200
from the worklist proves nothing about it (emr/units/b.json:159). This probe runs the product's compiled modules inside
the target API image, with the API's own runtime credential and state volume (EmrLedgerClient, StateCoordinator,
FailureJournal, PrismaLedgerSql, AccessSeal, AccessLedgerStore):

  process 1  recoverAtStart -> append one synthetic event -> durable receipt -> the same event again (replay)
  process 2  recoverAtStart (a new process: restart recovery) -> the same entry and the same sealed position

The event is a service job (executor "service", cause "service-job", an in-process surface with no patient target)
whose work context names the plan's synthetic study selector, so the ledger never shows it as a person's viewing.
There is no raw SQL write, no new route, and the ledger rows are kept (no cleanup). The verdict binds: one new row,
zero duplicates on replay, the external seal over that row, and the same chain after restart.

  python scripts/ops_emr_probe.py event --plan PLAN.json         the synthetic event the plan's probe fields give
  python scripts/ops_emr_probe.py verify FIRST.json SECOND.json --event-id ID
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import uuid

import ops_emr_introduction as intro_module
from ops_emr_introduction import Stop, require, result_line

SURFACE = "GET health"   # an in-process system surface whose route contract admits a service job
PROBE_ISSUER = "urn:kin:release-probe"

PROBE_SCRIPT = r"""
'use strict';
const dist='/app/dist';
const M=require(dist+'/emr-contract/composition');
const CTX=require(dist+'/emr-runtime/context');
M.composeEmrAdapters(CTX.runtimeAdapters);
const {EmrLedgerClient}=require(dist+'/emr-runtime/client');
const {StateCoordinator}=require(dist+'/emr-runtime/coordinator');
const {FailureJournal}=require(dist+'/emr-runtime/failure-journal');
const {PrismaLedgerSql,AccessLedgerStore}=require(dist+'/emr-runtime/store');
const {AccessSeal}=require(dist+'/emr-runtime/seal');
const [operation, raw]=process.argv.slice(1);
const input=JSON.parse(raw);
const out=v=>process.stdout.write('KIN_RESULT '+JSON.stringify(v)+'\n');
const position=t=>({sequence:Number(t.sequence),hash:t.hash});
const sealedViewing=seal=>{const s=seal.read();return s==='absent'?null:{sequence:Number(s.streams.viewing.sequence),hash:s.streams.viewing.hash};};
(async()=>{
  const state=process.env.KIN_EMR_STATE_DIR;
  const db=new EmrLedgerClient(process.env.DATABASE_URL);
  await db.$connect();
  try{
    const coordinator=new StateCoordinator(state);
    const journal=new FailureJournal(state,coordinator);
    const sql=new PrismaLedgerSql(db);
    const seal=new AccessSeal(state,sql,journal);
    const store=new AccessLedgerStore(db,sql,seal,journal,db.emrAppendPoolSize);
    const recovery=await seal.recoverAtStart();
    const eventId=operation==='append'?input.event.eventId:input.eventId;
    const result={operation,recovery:{recovered:recovery.recovered,notCommitted:recovery.notCommitted},
      tail_before:position(await sql.tail('viewing')),existed_before:(await sql.entryForEvent('viewing',eventId))!==null,
      journal_before:journal.all().length};
    if(operation==='append'){
      result.receipt=await store.append(input.event);
      result.tail_after=position(await sql.tail('viewing'));
      result.replay=await store.append(input.event);
      result.tail_replay=position(await sql.tail('viewing'));
    }
    const stored=await sql.entryForEvent('viewing',eventId);
    result.stored=stored&&{sequence:Number(stored.sequence),hash:stored.hash,kind:stored.kind,eventId:stored.eventId};
    result.sealed=sealedViewing(seal);
    result.journal_after=journal.all().length;
    out(result);
  }finally{await db.$disconnect();}
})().catch(e=>{out({operation,error:String((e&&(e.code||e.name))||'Error')});process.exitCode=1;});
"""


def probe_event(probe, occurred_at=None):
    """The synthetic service-job event for the plan's probe fields (deterministic apart from its creation time/link)."""
    require(type(probe.get("study")) is str and probe["study"].startswith("SYNTHETIC-"), "Probe study must be a synthetic selector")
    at = occurred_at or datetime.now(timezone.utc)
    stamp = at.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (at.microsecond // 1000)
    not_applicable = {"status": "not-applicable", "reason": "non-record-target"}
    service = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, PROBE_ISSUER + ":" + probe["institution"])), "issuer": PROBE_ISSUER,
               "subject": "release-probe"}
    return {"formatVersion": 1, "surface": SURFACE, "eventId": probe["event_id"],
            "userId": {"status": "known", "value": service}, "rolesAtTime": {"status": "known", "value": ["release-probe"]},
            "actingInstitution": {"status": "known", "value": probe["institution"]},
            "managingInstitution": {"status": "known", "value": probe["institution"]}, "occurredAt": stamp,
            "trustedProxyIp": {"status": "not-applicable", "reason": "in-process-service"}, "cause": "service-job",
            "context": {"basis": "service-job", "studyId": probe["study"], "relatedStudyId": None, "reason": None},
            "executor": "service",
            "targets": [{"kind": "system-operation", "patientLinkSnapshot": not_applicable, "studyId": not_applicable,
                         "recordId": not_applicable, "versionId": not_applicable}],
            "action": "provide-prepared", "result": "prepared", "requestId": "release-probe-" + probe["event_id"],
            "auditLinkId": "audit:" + str(uuid.uuid4()), "relatedEventId": None}


def _position(value):
    require(type(value) is dict and type(value.get("sequence")) is int and type(value.get("hash")) is str, "Unreadable chain position")
    return value


def verify(first, second, event_id):
    """The probe's verdict from the two processes' own outputs; anything short of the full chain is a refusal."""
    for value, operation in ((first, "append"), (second, "restart")):
        require(type(value) is dict and value.get("operation") == operation and "error" not in value, "Probe process failed: " + operation)
    receipt = first["receipt"]
    require(type(receipt) is dict and receipt.get("eventId") == event_id and type(receipt.get("durableAt")) is str, "No durable receipt for the event")
    require(first["replay"] == receipt, "The replay did not return the original receipt")
    before, after, replay = (_position(first[key]) for key in ("tail_before", "tail_after", "tail_replay"))
    added = after["sequence"] - before["sequence"]
    require(added == (0 if first["existed_before"] else 1), "The append did not add exactly one ledger entry")
    require(replay == after, "The replay added a ledger entry")
    stored = first["stored"]
    require(type(stored) is dict and stored.get("eventId") == event_id and stored.get("kind") == "access", "The stored entry is not the event")
    if not first["existed_before"]:
        require({"sequence": stored["sequence"], "hash": stored["hash"]} == after, "The stored entry is not the chain tail")
    sealed = _position(first["sealed"])
    require(sealed["sequence"] >= stored["sequence"], "The external seal does not cover the entry")
    if not first["existed_before"]:
        require(sealed == after, "The external seal is not at the entry")
    require(first["recovery"]["notCommitted"] == 0 and first["journal_after"] == first["journal_before"], "The probe left a failure record")
    require(second["existed_before"] is True and second["stored"] == stored, "Restart recovery lost the entry")
    require(_position(second["tail_before"]) == replay and _position(second["sealed"]) == sealed, "Restart recovery changed the chain")
    require(second["recovery"]["recovered"] == 0 and second["recovery"]["notCommitted"] == 0, "Restart recovery found unsealed work")
    require(second["journal_after"] == first["journal_after"], "Restart recovery left a failure record")
    return {"event_id": event_id, "receipt": receipt, "entry": {"sequence": stored["sequence"], "hash": stored["hash"]},
            "sealed": sealed, "added": added, "replay_duplicates": 0, "restart": "same chain and seal"}


def run(host_ops, intro):
    """Two one-shot processes of the target API service (its runtime credential, its state volume), never the server."""
    event = intro.state.get("probe_event")
    if event is None:
        # Persisted before the first append: a re-run replays the identical event (the same ID with other content
        # would be a ledger conflict, never a second fact).
        event = probe_event(intro.plan["probe"])
        intro.state["probe_event"] = event
        intro.save()
    first_run = host_ops.one_shot(intro, "api", ["-e", PROBE_SCRIPT, "append", json.dumps({"event": event})], timeout=300,
                                  entrypoint="node", name="emr-probe")
    require(first_run["exit"] == 0 and first_run["container_exit"] == 0, "Probe append process failed")
    second_run = host_ops.one_shot(intro, "api", ["-e", PROBE_SCRIPT, "restart", json.dumps({"eventId": event["eventId"]})],
                                   timeout=300, entrypoint="node", name="emr-probe-restart")
    require(second_run["exit"] == 0 and second_run["container_exit"] == 0, "Probe restart process failed")
    first, second = result_line(first_run["stdout"]), result_line(second_run["stdout"])
    evidence = verify(first, second, event["eventId"])
    digest = intro.records.put("probe-evidence.json", {"evidence": evidence, "first": first, "second": second,
                                                        "logs": [first_run["logs"], second_run["logs"]],
                                                        "approved_by": intro.plan["probe"]["approved_by"],
                                                        "approved_at": intro.plan["probe"]["approved_at"]})
    return {**evidence, "evidence_sha256": digest}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    event = sub.add_parser("event")
    event.add_argument("--plan", type=Path, required=True)
    check = sub.add_parser("verify")
    check.add_argument("first", type=Path)
    check.add_argument("second", type=Path)
    check.add_argument("--event-id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "event":
            plan = intro_module.plan_valid(intro_module.decode(args.plan.read_bytes()))
            print(json.dumps(probe_event(plan["probe"])))
        else:
            print(json.dumps(verify(json.loads(args.first.read_text(encoding="utf-8")),
                                    json.loads(args.second.read_text(encoding="utf-8")), args.event_id)))
    except (Stop, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"valid": False, "error": intro_module.code_of(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
