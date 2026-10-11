"""D874 disposable diagnostic selection; raw measurements, not a retry of L03.

Only directly declared diagnostic methods are selected. EmrBLedgerLive owns and
cleans its network-none tmpfs DB, fresh credentials and labelled state volumes.
"""
import json
import os
from pathlib import Path
from live import EmrBLedgerLive


class ThroughputDiagnosis(EmrBLedgerLive):
    def test_measure_round3_and_round4(self):
        output = Path(os.environ["EMR_THROUGHPUT_OUTPUT"])
        output.mkdir(parents=True, exist_ok=False)
        probe = """
CREATE FUNCTION public.emrb_measure_lock(s text) RETURNS double precision
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE started timestamptz := clock_timestamp();
BEGIN
  PERFORM 1 FROM emr_access.chain_head WHERE stream=s FOR UPDATE;
  RETURN extract(epoch FROM clock_timestamp()-started)*1000;
END $$;
REVOKE ALL ON FUNCTION public.emrb_measure_lock(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emrb_measure_lock(text) TO kin_runtime;
"""
        versions = [("r3", os.environ["EMR_R3_IMAGE"]), ("r4", self.image)]
        if os.environ.get("EMR_THROUGHPUT_BASELINE_ONLY") == "1":
            versions = versions[:1]
        for revision, image in versions:
            current = self.image
            try:
                # Provision/migrate are class methods; bind their image as well as the driver.
                type(self).image = image
                for count in (24, 48):
                    db = self.start_db(revision + "-" + str(count))
                    self.provision(db)
                    self.migrate(db)
                    self.ok(probe, db=db)
                    state = self.volume(revision + "-" + str(count))
                    result = self.driver("append", {"count": count, "concurrent": True, "measure": True, "headProbe": True}, db=db, volume=state)
                    (output / (revision + "-" + str(count) + ".json")).write_text(json.dumps(result, indent=2), encoding="utf-8")
                    self.assertEqual(len(result.get("results", [])), count, result)
                    print("THROUGHPUT", revision, count, json.dumps(result["summary"]), flush=True)
                    if revision == "r3":
                        self.assertEqual(result["summary"]["failures"], 0, result)
            finally:
                type(self).image = current
