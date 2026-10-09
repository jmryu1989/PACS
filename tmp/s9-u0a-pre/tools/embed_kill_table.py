# coding: utf-8
"""Writes the kill table (kill-table.json) into tests/main_early_input_mutants.py's MUTANTS literal."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
rows = json.loads((ROOT / "tmp/s9-u0a-pre/kill-table.json").read_text(encoding="utf-8"))
driver = ROOT / "tests/main_early_input_mutants.py"
source = driver.read_text(encoding="utf-8")
start = source.index("MUTANTS = [")
end = source.index("\n]\n", start) + 3 if "MUTANTS = [\n" in source else source.index("\n", start) + 1
lines = ["MUTANTS = ["]
for row in rows:
    lines.append('    {"id": %s, "case": %s,\n     "expect": %s},' % (json.dumps(row["id"]), json.dumps(row["case"]),
                                                                   json.dumps(row["expect"], ensure_ascii=False)))
lines.append("]")
header = ("# One case per mutant that fails on it with the mutant's own text (the moved binding, or the user result for the\n"
          "# saved-search chips and the two registration mutants), chosen from the full local runs of every mutant.\n")
before = source[:start]
if not before.endswith(header):
    before += header
driver.write_text(before + "\n".join(lines) + "\n" + source[end:], encoding="utf-8", newline="\n")
print(len(rows))
