#!/usr/bin/env python3
"""One-shot PostgreSQL ledger probe (REQ-B2R-07 / OPS-01).

The selected API image checks its runtime role, durability and storage placement, appends one synthetic service
event, then replays it. A second process looks up that committed operation and the same legal entry. Sequence gaps
are valid. This probe is not HTTP/clinical acceptance, disaster recovery or a whole-ledger integrity scan.
The caller persists the event and attempt keys before launching either process. It runs one probe at a time;
the failure-only spool is separate from the API's writer. No pending operation belonging to the API is settled.

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
const path=require('node:path');
const dist=path.resolve('dist');
const M=require(dist+'/emr-contract/composition');
const CTX=require(dist+'/emr-runtime/context');
M.composeEmrAdapters(CTX.runtimeAdapters);
const {EmrLedgerClient}=require(dist+'/emr-runtime/client');
const {FailureJournal,FailureSpool}=require(dist+'/emr-runtime/failure-journal');
const {AccessLedgerStore}=require(dist+'/emr-runtime/store');
const {verifyRuntimeConnection}=require(dist+'/emr-runtime/manifest');
const [operation, raw]=process.argv.slice(1);
const input=JSON.parse(raw);
const out=v=>process.stdout.write('KIN_RESULT '+JSON.stringify(v)+'\n');
(async()=>{
  const state=process.env.KIN_EMR_STATE_DIR;
  if(!state) throw new Error('EmrFailureDirectoryRequired');
  const db=new EmrLedgerClient(process.env.DATABASE_URL);
  const journal=new FailureJournal(db,new FailureSpool(path.join(state,'probe-outage')));
  const store=new AccessLedgerStore(db,journal);
  let result;
  try{
    await db.$connect();
    const readiness=await verifyRuntimeConnection(db);
    await journal.replay();
    if(!['append','restart'].includes(operation)) throw new Error('ProbeOperationInvalid');
    const eventId=operation==='append'?input.event.eventId:input.eventId;
    result={operation,readiness,existed_before:(await store.sql.entryForEvent('viewing',eventId))!==null};
    if(operation==='append'){
      if(!input.keys?.operationId || !input.keys?.attemptId) throw new Error('ProbeAttemptKeysRequired');
      const admitted=await store.admit(input.event,undefined,input.keys);
      result.outcome=await store.transaction(admitted,async()=>null);
      result.receipt=store.receipt(result.outcome);
      const replay=await store.admit(input.event,undefined,input.keys);
      result.replay_outcome=await store.transaction(replay,async()=>null);
      result.replay=store.receipt(result.replay_outcome);
    }else{
      result.outcome=await store.lookup(input.operationId);
      if(!result.outcome) throw new Error('ProbeOutcomeMissing');
      result.receipt=store.receipt(result.outcome);
    }
    const stored=await store.sql.entryForEvent('viewing',eventId);
    result.stored=stored&&{entryId:stored.entryId,sequence:stored.sequence,stream:stored.stream,kind:stored.kind,eventId:stored.eventId};
  }finally{
    const cleanup=await Promise.allSettled([journal.close(),db.$disconnect()]);
    if(cleanup.some(r=>r.status==='rejected')) throw new Error('ProbeCleanupFailed');
  }
  // Completion is published after cleanup, so a failed close cannot masquerade as a passed probe.
  out(result);
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


def _time(value):
    require(type(value) is str, "Unreadable receipt time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise Stop("Unreadable receipt time")
    require(parsed.tzinfo is not None, "Receipt time has no timezone")
    # The public JavaScript receipt has millisecond precision; PG keeps microseconds.
    return parsed.replace(microsecond=parsed.microsecond // 1000 * 1000)


def verify(first, second, event_id):
    """Check the selected event's immutable outcome, not a contiguous sequence or an external witness."""
    for value, operation in ((first, "append"), (second, "restart")):
        require(type(value) is dict and value.get("operation") == operation and "error" not in value, "Probe process failed: " + operation)
        readiness = value.get("readiness")
        require(type(readiness) is dict and readiness.get("role") == "kin_runtime"
                and type(readiness.get("relations")) is int and readiness["relations"] > 0, "PG readiness missing")
        receipt, outcome, stored = value.get("receipt"), value.get("outcome"), value.get("stored")
        require(type(receipt) is dict and receipt.get("eventId") == event_id
                and type(receipt.get("durableAt")) is str, "No durable receipt for the event")
        require(type(outcome) is dict and outcome.get("outcome") == "committed" and outcome.get("eventId") == event_id
                and type(outcome.get("operationId")) is str and _time(outcome.get("durableAt")) == _time(receipt["durableAt"])
                and outcome.get("result") is None, "No matching committed outcome")
        require(type(stored) is dict and stored.get("eventId") == event_id and stored.get("kind") == "access"
                and stored.get("stream") == "viewing" and type(stored.get("entryId")) is str
                and type(stored.get("sequence")) is int and stored["sequence"] > 0, "The stored entry is not the event")
        entries = outcome.get("entries")
        require(type(entries) is list and len(entries) == 1 and type(entries[0]) is dict
                and entries[0].get("entryId") == stored["entryId"] and entries[0].get("stream") == "viewing"
                and type(entries[0].get("attemptId")) is str and entries[0].get("expired") is False,
                "Outcome does not reference the one retained entry")
        require(type(value.get("existed_before")) is bool, "Missing pre-append observation")
    receipt, stored = first["receipt"], first["stored"]
    require(first["replay"] == receipt, "The replay did not return the original receipt")
    require(first["replay_outcome"] == first["outcome"], "The replay changed the committed outcome")
    require(second["existed_before"] is True and second["stored"] == stored, "Restart recovery lost the entry")
    require(second["outcome"] == first["outcome"] and second["receipt"] == receipt, "Restart changed the committed outcome")
    return {"event_id": event_id, "receipt": receipt, "entry": {"entryId": stored["entryId"], "sequence": stored["sequence"]},
            "operation_id": first["outcome"]["operationId"], "added": 0 if first["existed_before"] else 1,
            "replay_duplicates": 0, "restart": "same PostgreSQL outcome and entry"}


def run(host_ops, intro):
    """Two one-shot processes of the target API service (its runtime credential, its state volume), never the server."""
    event = intro.state.get("probe_event")
    if event is None:
        # Persisted before the first append: a re-run replays the identical event (the same ID with other content
        # would be a ledger conflict, never a second fact).
        event = probe_event(intro.plan["probe"])
        intro.state["probe_event"] = event
        intro.save()
    keys = intro.state.get("probe_keys")
    if keys is None:
        keys = {"operationId": str(uuid.uuid4()), "attemptId": str(uuid.uuid4())}
        intro.state["probe_keys"] = keys
        intro.save()
    first_run = host_ops.one_shot(intro, "api", ["--max-old-space-size=3072", "-e", PROBE_SCRIPT, "append", json.dumps({"event": event, "keys": keys})], timeout=300,
                                  entrypoint="node", name="emr-probe")
    require(first_run["exit"] == 0 and first_run["container_exit"] == 0, "Probe append process failed")
    first = result_line(first_run["stdout"])
    second_run = host_ops.one_shot(intro, "api", ["--max-old-space-size=3072", "-e", PROBE_SCRIPT, "restart",
                                   json.dumps({"eventId": event["eventId"], "operationId": first["outcome"]["operationId"]})],
                                   timeout=300, entrypoint="node", name="emr-probe-restart")
    require(second_run["exit"] == 0 and second_run["container_exit"] == 0, "Probe restart process failed")
    second = result_line(second_run["stdout"])
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
