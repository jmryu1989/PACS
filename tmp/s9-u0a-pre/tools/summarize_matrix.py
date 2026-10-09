# coding: utf-8
"""Compress a matrix probe JSON: per layout and input group, the held boundaries with each distinct error."""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def ranges(numbers):
    numbers, out = sorted(numbers), []
    for n in numbers:
        if out and out[-1][1] == n - 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ",".join(f"{a}" if a == b else f"{a}-{b}" for a, b in out)


def main():
    report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    held = defaultdict(lambda: defaultdict(set))
    sources = defaultdict(set)
    notes = defaultdict(set)
    for row in report["held"]:
        for group, value in row["groups"].items():
            if isinstance(value["note"], str) and ("input failed" in value["note"] or "moved to" in value["note"]):
                notes[(row["count"], group, value["note"][:90])].add(row["ran_modules"])
            for error in value["errors"]:
                held[(row["count"], group)][error["message"]].add(row["ran_modules"])
                sources[(group, error["message"])].add(f"{error['target']} {error['type']}")
    print("## held boundaries (k = modules that ran; part k is held)")
    for (count, group), messages in sorted(held.items()):
        for message, ks in sorted(messages.items()):
            print(f"{count:>2} {group:<11} k={ranges(ks):<12} {message}  <- {sorted(sources[(group, message)])}")
    for (count, group, note), ks in sorted(notes.items()):
        print(f"{count:>2} {group:<11} k={ranges(ks):<12} note: {note}")
    groups = sorted({g for row in report["held"] for g in row["groups"]})
    clean = {g: sum(1 for row in report["held"] if g in row["groups"] and not row["groups"][g]["errors"]) for g in groups}
    given = {g: sum(1 for row in report["held"] if g in row["groups"]) for g in groups}
    print("## held boundaries without any error, per group: " + ", ".join(f"{g} {clean[g]}/{given[g]}" for g in groups))
    print("## timed (first input as soon as the registering module ran)")
    timed = defaultdict(list)
    for row in report["timed"]:
        key = (row["count"], row["delay_ms"], row["hazard"])
        if "errors" not in row:
            timed[key].append("n/a")
        else:
            timed[key].append("reproduced" if row["errors"] else "not")
    for key, results in sorted(timed.items()):
        first = next((r for r in report["timed"] if (r["count"], r["delay_ms"], r["hazard"]) == key), {})
        msgs = sorted({e["message"] for r in report["timed"] if (r["count"], r["delay_ms"], r["hazard"]) == key
                       for e in r.get("errors", [])})
        print(f"{key[0]:>2} {key[1]:>3}ms {key[2]}: {results} {msgs} {first.get('note', '') if 'errors' not in first else ''}")


if __name__ == "__main__":
    main()
