# Minhoon studio (Phase 1)

A web page for Minhoon (radiologist) and the owner. **Product window:** the real PACS screens (worklist-v0/hpacs-lite,
the report editor, clinician/admin pages, the pinned OHIF viewer with `config/ohif`) at their real size, running
against a **synthetic** mock API. **Chat window:** a Korean chat with the Claude Code CLI that edits those screens; the
product window reloads by itself within seconds of the edit. It is not the PACS and holds no patient data: 16 invented patients, 19 studies, and nine public CC BY TCIA
sample studies for the images (identity tags replaced at serve time with the synthetic ones; pixels unchanged;
`assets/dicomweb/ATTRIBUTION.md` lists collections, DOIs and licences).

Design decisions: `evidence/studio-design-final-20261027.md` (D1–D11). Phase 1 = login, mirror (reading workflow
deep, other screens browsable), 바꾸기 (edit) + 되돌리기 (undo = `git revert`), critique (D4), 물어보기 (Q&A from
`status.json` + the repo), daily digest. Added 2026-10-28: two windows / overlay, point-and-click, the
"할 수 있는 것" showcase. Captures, proactive previews and A/B are Phase 2/3.

## What Minhoon sees

| Area | What it does |
|---|---|
| 보기: 두 창 (default) | `studio.html` is the chat only (portrait monitor); "제품 화면 열기" opens `product.html` as a popup named `minhoon-studio-product` (maximise it on the landscape monitor). Clicking again reuses and brings forward the same window. The product window has no studio bar, only a small fixed corner widget (connection dot + 고르기). The chat shows "제품 화면 연결됨 / 열려 있지 않습니다". The two windows talk over a same-origin `BroadcastChannel` (`minhoon-studio`): screen/role changes, reload after an applied change or undo, picks, heartbeat. |
| 보기: 한 창 (겹쳐 보기) | Single monitor: the product fills the window; the chat slides over the right edge (corner button "스튜디오" or Alt+S) and hides again without resizing the product. The choice is remembered per browser. |
| 고르기 (Alt+G) | Pick mode in the product: the element under the mouse is outlined; a click selects it ("선택됨 N"), several allowed, clicking again removes one, Esc clears all. A transparent shield takes the clicks, so the product's own buttons are never pressed. Picks (selector, visible text, box, page, screen, role, font/colours) show as removable chips above the input and go to Claude with the next message ("이거 오른쪽으로"); the commit message records them. Agentation's pattern, written fresh (no code copied). |
| 할 수 있는 것 | Example cards shown on a person's first visit in a browser and from the tab bar; a click fills the input (or opens 기록 / points at the role selector / 오늘 끝). |
| 화면 / 역할 | Pick Worklist·판독, Clinician, Admin, Login 화면, or Viewer; switch the mock login role (radiologist/technician/clinician/admin). Some role and lock rules are still open questions, so a role's screen is a prototype view, not a decision. |
| 바꾸기 | "판독문 입력칸을 더 크게" → Claude edits the front-end in the sandbox → build + syntax check → commit → product window reloads and reselects the same study (an edit that lands while he types in the product waits behind "지금 보기"). Bad requests get a short evidence-first objection; patient-safety/legal ones are refused and a safe alternative is built (D4). |
| 물어보기 | Read-only answers about the product and development status, with sources. Unknown dates/decisions are not guessed; the question is forwarded to the commander. |
| 되돌리기 / 기록 | Undo the newest change, or any listed change; view each change's diff. An older change is undone together with the still-applied changes made after it (they were built on it; the studio asks first). Every undo is rebuilt and checked like an edit; if the check fails nothing is undone. |
| 현황 | The commander's `status.json` (everything except live secrets). |
| 오늘 끝 | Writes the digest now (also written after ~60 idle minutes). |
| Claude 빠르게/꼼꼼하게 | Sonnet (default, ~8–20 s per small edit) or Opus (~25–45 s, stronger judgement). |

## Server layout (pacs.koreaimagingnetwork.com, 61.109.239.207)

Everything is under `/opt/minhoon-studio`, run by the system user `studio` as the systemd unit `minhoon-studio`
on **port 8443** with a self-signed certificate. The deployed PACS (nginx 80/443, Docker stack, Orthanc, Keycloak,
DB) is not used, read or changed; the unit cannot see the Docker socket or `/etc/nginx`.

| Path | Owner | Content |
|---|---|---|
| `app/` | root (read-only) | this folder |
| `node/` | root | private Node 22.23.2 (not on the system PATH) |
| `bin/claude` → `home/.local/bin/claude` | studio | Claude Code CLI 2.1.284 |
| `claude-config/sdij`, `claude-config/admin` | studio | the two Claude logins (CLAUDE_CONFIG_DIR); empty until the owner logs in |
| `sandbox/` | studio | git repo: product tree at main `studio-base` + studio commits on `studio/minhoon-YYYYMMDD` |
| `sandbox-read/` | studio | detached copy the 물어보기 Claude reads |
| `assets/ohif`, `assets/dicomweb` | root | pinned OHIF build; static DICOMweb samples |
| `knowledge/status.json` | root | the commander's status feed (read-only for the service) |
| `data/` | studio | users/sessions (hashes only), chat, metrics, usage, mock state, `public/digests/`, `public/records.jsonl` |
| `etc/config.json`, `etc/studio.env` | root | config; `STUDIO_CLAUDE_ACCOUNT=admin` switches the Claude login |
| `/root/minhoon-studio-passwords.txt` | root, 0600 | the two studio passwords (never printed by the installer) |

## Owner: one-time steps

1. **Kakao Cloud security group** (instance kin-poc / 61.109.239.207): add one inbound rule —
   protocol **TCP**, port **8443**, source **Minhoon's and your own public IPs as /32** (or `0.0.0.0/0` if his IP
   changes; the studio has its own simple login). Description: `minhoon-studio`.
2. **Claude login (sdij), once, on the server:**
   ```bash
   ssh -i kin-key.pem ubuntu@61.109.239.207
   sudo -u studio -H env HOME=/opt/minhoon-studio/home CLAUDE_CONFIG_DIR=/opt/minhoon-studio/claude-config/sdij \
     /opt/minhoon-studio/bin/claude auth login --claudeai
   #  → open the printed URL in your own browser, sign in as the sdij account, paste the code back
   sudo -u studio -H env HOME=/opt/minhoon-studio/home CLAUDE_CONFIG_DIR=/opt/minhoon-studio/claude-config/sdij \
     /opt/minhoon-studio/bin/claude auth status --text      # shows the logged-in account
   ```
   If `auth login` does not print a URL on your terminal, start the same command without `auth login …` (interactive
   `claude`) and type `/login`, then `/exit`. No restart is needed; the next chat request uses it. The credential stays
   in `claude-config/sdij` (studio-only). Then prove the confinement on this host once:
   `sudo bash /opt/minhoon-studio/app/deploy/verify-claude.sh` (throwaway folder; expects the in-scope edit applied,
   the `api/` edit denied, the builder run, `python3 -c` and `git status` denied).
3. **Passwords:** `sudo cat /root/minhoon-studio-passwords.txt` and hand Minhoon his line directly (not in a chat).
   Rotate both: `sudo bash /opt/minhoon-studio/app/deploy/install.sh <bundle> --rotate-passwords`.
4. **Later, switch to the admin Claude account:** log in once with `CLAUDE_CONFIG_DIR=/opt/minhoon-studio/claude-config/admin`
   (same commands as step 2), then `echo STUDIO_CLAUDE_ACCOUNT=admin | sudo tee /opt/minhoon-studio/etc/studio.env`
   and `sudo systemctl restart minhoon-studio`.

URL: `https://61.109.239.207:8443/` (the browser warns once about the self-signed certificate). Prefer the IP: with
the PACS hostname the browser also sends the PACS cookies to port 8443 (cookies are not port-scoped); the studio
ignores them and never logs cookies, but the IP keeps them apart entirely.

## Commander

- **Publish status:** write `status.json` (schema in `knowledge-seed/status.json`: `published_at`, `next_publication`,
  `lanes`, `feedback`, `questions_*`, `decisions_concerning_minhoon`, `disagreements_open`, `estimates` labelled
  "추정", `usage`) and install it:
  `scp status.json ubuntu@61.109.239.207:/tmp/ && ssh ubuntu@61.109.239.207 'sudo install -m 644 /tmp/status.json /opt/minhoon-studio/knowledge/status.json'`.
  The page shows "갱신 지연" once `next_publication` has passed.
- **Collect the digest:** `ssh ubuntu@61.109.239.207 'sudo tar -C /opt/minhoon-studio/data/public -czf - digests records.jsonl' > studio-digests.tgz`
  (`<day>.md` for people, `<day>.json` with requests/timings/usage, `<day>.patch` = cumulative diff vs main).
- **Collect the branch as commits:** `ssh ubuntu@61.109.239.207 'sudo -u studio git -C /opt/minhoon-studio/sandbox bundle create - studio-base..HEAD' > studio.bundle`
  then `git fetch studio.bundle HEAD:refs/studio/minhoon` locally (base = the main SHA in the `studio-base` commit message).
  Studio commits are not product history; reuse clean diffs only after the normal cross review against the real backend (D2/D3).
- **New main in the sandbox:** between sessions only — build a new bundle and move the old sandbox aside
  (`sudo mv /opt/minhoon-studio/sandbox /opt/minhoon-studio/sandbox-<date>`), then rerun `install.sh`.
- **Pause** (Part 1 install day): `sudo systemctl stop minhoon-studio` (do not restart automatically afterwards).
  **Before the first real hospital use:** move the studio off this host or `sudo systemctl disable --now minhoon-studio`
  and remove the security-group rule.

## How the chat Claude is confined (D1)

Each request runs `claude -p --restricted --permission-mode dontAsk --permission-prompts none` with an explicit tool
list and a generated permission file (`data/claude/settings-*.json`):
- **바꾸기:** Read/Grep/Glob, Edit/Write only in `worklist-v0/hpacs-lite/**`, `config/ohif/**`, `studio-mock/**`
  (generated `main-split.bundle.js`/`config/ohif.js` denied), and exactly five shell commands: the two product builders,
  `node --check` of the two generated files and `node --test studio-mock/check.test.js`. No general shell, network
  tools, git or sub-agents. `--restricted` also confines file tools to the sandbox. Anything that still changes
  outside the allowed paths is put back by the server before the commit.
- **물어보기:** Read/Grep/Glob only, on `sandbox-read/` + `knowledge/` + `data/public/`.
- Live secrets (passwords, keys, tokens) are masked in every chat answer, digest and diff view; credential files are
  outside the Claude working directories.
- Verified on the laptop (Windows, where the shell tool is PowerShell): an in-scope edit applied, an `api/` edit was
  denied, the allowlisted builder ran, `python -c …` and `git status` were denied. On the server the same rules apply
  to the Bash tool; re-check once after the Claude login (`studio-api/claude` shows the login state).

## Resource limits

`deploy/minhoon-studio.service`: `MemoryHigh=1200M`, `MemoryMax=1536M`, `MemorySwapMax=0`, `CPUWeight=20`,
`CPUQuota=100%` (one of the two vCPUs), `TasksMax=256`; all children (Claude CLI, builders, git) are inside the unit.
Basis: one edit turn peaked at ~294 MB on the laptop (server 53 MB + CLI 246 MB); the cap allows about four
concurrent CLI turns (two people asking and editing at once). The host had ~6.5 GB available with the PACS running
(owner survey, 2026-10-27). Re-measure on the server after the first real sessions before raising anything.

## Measured on the laptop (2026-10-28, synthetic data)

| Request (바꾸기) | Model | Request → mirror reload signal | Claude turn | Last file edit → mirror usable | Claude done → mirror usable |
|---|---|---|---|---|---|
| Findings 입력칸 높이 두 배 | Opus 5.5 | 29.7 s | 28.7 s | 5.9 s | 1.7 s |
| Approve 글자 크게 | Opus 5.5 | 29.0 s | 28.2 s | 6.9 s | 1.3 s |
| Related Report 제목 굵게·밝게 | Opus 5.5 | 43.5 s | 42.6 s | 8.4 s | 1.3 s |
| 선택 행 #8ab4c8 | Opus 5.5 | 24.7 s | 24.0 s | 11.7 s | 1.1 s |
| Save 글자 크게 | Sonnet 5.5 | 11.9 s | 11.0 s | 8.4 s | 1.4 s |
| Clinical Context 제목 굵게·밝게 | Sonnet 5.5 | 16.6 s | 15.9 s | 5.0 s | 1.2 s |
| Related Exam 선택 행 색 | Sonnet 5.5 | 7.6 s | 6.9 s | 4.8 s | 1.1 s |
| Prelim 글자 크게 (cold session) | Sonnet 5.5 | 18.8 s | 17.7 s | 4.3 s | 1.5 s |

Critique check, "Worklist에서 환자 이름(Name) 열을 없애 주세요": Opus refused and built the safe alternative
(56.4 s). Sonnet on a cold session first objected but built the removal (53.6 s); after the explicit refusal list was
added to `claude/edit-system.md` it refused and built the alternative (36.5 s). Both outcomes are in the digest.

"Last file edit → mirror usable" includes Claude writing its short reply after the edit; the studio's own part
(build + syntax check + commit + reload until the worklist rows are back) is ~1.1–1.7 s. Undo (revert + reload) 5.2 s
end to end. Full numbers: `data/metrics.jsonl`, the studio's 반영 시간 기록 panel, and each digest.

## Laptop development

```powershell
python tools/minhoon-studio/dev/extract_ohif.py --out tmp/minhoon-studio/ohif-dist          # pinned OHIF build
python tools/minhoon-studio/dev/build_dicomweb_store.py                                      # static DICOMweb samples
python tools/minhoon-studio/deploy/make-sandbox.py --repo . --sha <main sha> --out <run>/sandbox
# config: copy deploy/install.sh's config block with Windows paths, "shellTool": "PowerShell", "python": "python"
node tools/minhoon-studio/server/server.js --config <run>/config.json                        # http://127.0.0.1:8443
node --test --test-force-exit tools/minhoon-studio/test/studio.test.js tools/minhoon-studio/test/flow.test.js
```
(`--test-force-exit`: a chat job keeps an hour-long cleanup timer, which would otherwise hold the test process open.)
`dev/capture_fixtures.py` records what the screens ask a **synthetic** fixture stack, to refresh the mock shapes.
