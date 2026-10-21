#!/usr/bin/env python3
"""One-shot EMR ledger probe of the EMR-introduction release (INTERIM-RELEASE-TOOLS item 7, plan L-10 / TEST-IR-06.6).

B1 has no HTTP route that appends to the access ledger, so a 200 from the worklist proves nothing about it
(emr/units/b.json:159). EMR-B2 (c): this probe runs the product's compiled client-only modules inside the target API
image, with the API's own runtime credential, instance identifier and read-only IPC endpoint of the running
protected-state service (EmrApiClientRuntime, the record port, PrismaLedgerSql for read-back). It never mounts the
protected state volume, never recovers and never promotes: the service alone holds the fence and recovery.

  process 1  client session -> append one synthetic event -> durable receipt -> the same event again (replay)
  process 2  a new client session (API-only restart): the same entry, the same sealed position, the SAME service epoch
             and no pending work - the API restart performed no recovery

The event is a service job (executor "service", cause "service-job", an in-process surface with no patient target)
whose work context names the plan's synthetic study selector, so the ledger never shows it as a person's viewing.
There is no raw SQL write, no new route, and the ledger rows are kept (no cleanup). The verdict binds: one new row,
zero duplicates on replay, the external seal over that row, the same chain and service epoch after the API restart,
and no failure or pending record left on the service. A third observation after a separate service restart (another
epoch, the same chain and seal) is verified by `verify_after_service_restart` when the launcher provides it.

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
const {EmrApiClientRuntime}=require(dist+'/emr-runtime/application');
const {createRecordPort}=require(dist+'/emr-runtime/record-port');
const [operation, raw]=process.argv.slice(1);
const input=JSON.parse(raw);
const out=v=>process.stdout.write('KIN_RESULT '+JSON.stringify(v)+'\n');
const position=t=>({sequence:Number(t.sequence),hash:t.hash});
(async()=>{
  // The client runtime refuses a protected-state directory, verifies the runtime role, reads the DB identity and both
  // chains itself and compares them with the service's hello before any work: no owner, fence or recovery here.
  const runtime=new EmrApiClientRuntime(process.env);
  await runtime.start();
  try{
    const store=runtime.store(), sql=store.sql, session=runtime.session();
    const eventId=operation==='append'?input.event.eventId:input.eventId;
    const before=await runtime.status();
    const result={operation,service:{epoch:session.serviceEpoch,instanceId:session.instanceId,state:before.state},
      tail_before:position(await sql.tail('viewing')),existed_before:(await sql.entryForEvent('viewing',eventId))!==null,
      journal_before:before.journalRecords,pending_before:before.pending,sealed_before:position(before.sealed.viewing)};
    if(operation==='append'){
      const {port,control}=createRecordPort(store), work=port.begin();
      try{
        result.receipt=await work.append(input.event);
        result.tail_after=position(await sql.tail('viewing'));
        result.replay=await work.append(input.event);
        result.tail_replay=position(await sql.tail('viewing'));
      }finally{work.end();await control.drained();}
    }
    const stored=await sql.entryForEvent('viewing',eventId);
    result.stored=stored&&{sequence:Number(stored.sequence),hash:stored.hash,kind:stored.kind,eventId:stored.eventId};
    const after=await runtime.status();
    result.sealed=position(after.sealed.viewing);
    result.journal_after=after.journalRecords; result.pending_after=after.pending; result.scopes_after=after.scopes;
    out(result);
  }finally{await runtime.close();}
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


def _service(value):
    service = value.get("service")
    require(type(service) is dict and type(service.get("epoch")) is str and service["epoch"] and type(service.get("instanceId")) is str
            and service.get("state") == "ready", "Unreadable or unready service identity")
    return service


def verify(first, second, event_id):
    """The probe's verdict from the two client processes' own outputs; anything short of the full chain is a refusal.

    EMR-B2 (c): the second process is an API-only restart. It must see the same entry, the same sealed position and the
    SAME service epoch (no recovery happened: the service was not restarted and the API performed none), with no pending
    reservation, no live scope and no failure record left on the service.
    """
    for value, operation in ((first, "append"), (second, "restart")):
        require(type(value) is dict and value.get("operation") == operation and "error" not in value, "Probe process failed: " + operation)
    service, restarted = _service(first), _service(second)
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
    require(first["pending_after"] == 0 and first["scopes_after"] == 0, "The probe left pending or live work on the service")
    require(first["journal_after"] == first["journal_before"], "The probe left a failure record")
    require(second["existed_before"] is True and second["stored"] == stored, "API restart lost the entry")
    require(_position(second["tail_before"]) == replay and _position(second["sealed"]) == sealed, "API restart changed the chain")
    require(restarted["epoch"] == service["epoch"] and restarted["instanceId"] == service["instanceId"],
            "API restart changed the service epoch: a recovery or service replacement happened")
    require(second["pending_before"] == 0 and second["pending_after"] == 0 and second["scopes_after"] == 0, "API restart found pending work")
    require(second["journal_after"] == first["journal_after"], "API restart left a failure record")
    return {"event_id": event_id, "receipt": receipt, "entry": {"sequence": stored["sequence"], "hash": stored["hash"]},
            "sealed": sealed, "added": added, "replay_duplicates": 0, "restart": "same chain, seal and service epoch",
            "service_epoch": service["epoch"]}


def verify_after_service_restart(evidence, third, event_id):
    """After the service itself was restarted (its own fenced recovery) and a third client process observed: another
    epoch, the same entry, the same sealed position, no pending work and no failure record."""
    require(type(third) is dict and third.get("operation") == "restart" and "error" not in third, "Probe process failed: service-restart")
    service = _service(third)
    require(service["epoch"] != evidence["service_epoch"], "The service restart did not start a new epoch")
    require(third["existed_before"] is True and third["stored"] == {**third["stored"], **{"sequence": evidence["entry"]["sequence"], "hash": evidence["entry"]["hash"]}}
            and third["stored"].get("eventId") == event_id, "Service restart lost the entry")
    require(_position(third["sealed"]) == evidence["sealed"], "Service restart changed the seal")
    require(third["pending_before"] == 0 and third["pending_after"] == 0 and third["scopes_after"] == 0, "Service restart left pending work")
    require(third["journal_after"] == third["journal_before"], "Service restart left a new failure record")
    return {**evidence, "service_restart": "new epoch, same chain and seal", "service_epoch_after_restart": service["epoch"]}


def run(host_ops, intro):
    """Client-only one-shot processes of the target API service (its runtime credential, instance identifier and
    read-only IPC endpoint; no state volume), never the server: append+replay, an API-only restart, and - when the
    launcher can restart the state service - a third observation after that separate service restart."""
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
    record = {"evidence": evidence, "first": first, "second": second, "logs": [first_run["logs"], second_run["logs"]],
              "approved_by": intro.plan["probe"]["approved_by"], "approved_at": intro.plan["probe"]["approved_at"]}
    restart = getattr(host_ops, "restart_state_service", None)
    if restart is not None:
        record["service_restart"] = restart(intro)
        third_run = host_ops.one_shot(intro, "api", ["-e", PROBE_SCRIPT, "restart", json.dumps({"eventId": event["eventId"]})],
                                      timeout=300, entrypoint="node", name="emr-probe-service-restart")
        require(third_run["exit"] == 0 and third_run["container_exit"] == 0, "Probe process after the service restart failed")
        third = result_line(third_run["stdout"])
        evidence = verify_after_service_restart(evidence, third, event["eventId"])
        record.update(evidence=evidence, third=third, logs=record["logs"] + [third_run["logs"]])
    digest = intro.records.put("probe-evidence.json", record)
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
