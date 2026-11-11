# Query/Retrieve from another PACS: what a site must confirm before it works

Members ▸ DICOM Peers registers another PACS or modality of the hospital (name, AE Title, host,
port). Radiologists and technicians then search it from the worklist's More ▸ Query/Retrieve
(a Study-level C-FIND) and retrieve a study (a C-MOVE: the peer sends the study to this archive by
C-STORE). This page lists the conditions outside the product that a retrieve needs. They are
conditions to confirm with the hospital at deployment; writing them here does not make them true,
and a green CI run against the synthetic peer (`docker-compose.qr-peer.yml`) is not a site check.

## Conditions to confirm at the site

1. **The peer has this archive registered as a C-MOVE destination.** A C-MOVE names a destination
   by AE Title only; the peer looks up the address itself. The peer's administrator must register
   this archive's AE Title (Orthanc's `DicomAet` in `config/orthanc.json`, `KINLAB` unless the site
   changed it), the address the peer can reach it at, and the DICOM port. Without it the search
   works but every retrieve ends `Failed — 가져오지 못했습니다 — 상대 PACS에 KIN(AE …)이 목적지로
   등록돼 있는지 확인하세요`.
2. **This archive's DICOM port is reachable from the peer.** The production compose file publishes
   only Orthanc's HTTP port on loopback (`docker-compose.prod.yml`, the orthanc service's `ports`);
   the DICOM port 4242 is not published. A site that uses Query/Retrieve must open 4242 to the
   hospital network (and only to it) by its own deployment decision; the product does not open it.
3. **The peer answers C-FIND and C-MOVE from this archive's AE Title.** Many PACS accept queries
   and retrieves only from AE Titles they know; the peer's administrator registers this archive for
   that too.

## What the product does and does not decide

- Registering a peer is not registering a sending device. A retrieved study arrives like any other
  DICOM arrival: its hospital is decided by its InstitutionName (a registered spelling) or by the
  sending device (the peer's AE Title registered under Held Studies ▸ Register Device). A study
  neither decides is held, and the panel says `Held`.
- Orthanc is told each peer with echo and store allowed and find, find-worklist, get and move not
  allowed: a peer cannot query or pull from this archive through its registration.
- A search is answered up to 200 rows; a retrieve's `Arrived` means the study is in this archive and
  the member's own worklist opens it.
- Retrieves and searches are recorded in the audit log by criteria names, counts and identifiers
  (no patient values).
