# Minhoon studio (Phase 1)

A web page for Minhoon (radiologist) and the owner. **Product window:** the real PACS screens (worklist-v0/hpacs-lite,
the report editor, clinician/admin pages, the pinned OHIF viewer with `config/ohif`) at their real size, running
against a **synthetic** mock API. **Chat window:** a Korean chat with the Claude Code CLI that edits those screens; the
product window reloads by itself within seconds of the edit. It is not the PACS and holds no patient data: 20 invented patients, 27 studies, and for the images nine public CC BY TCIA
sample studies plus eight synthetic MG vendor phantom studies (Hologic, Siemens, GE, Fujifilm; each one study stored
uncompressed and one in the vendor's compressed syntaxes, from `scripts/mg_vendor_fixture.py`). Every phantom is
an R CC image and the product's MG hanging leaves a cell empty when two images fit it, so each study holds one
image per kind (Conventional / Synthetic 2D / DBT; FOR PROCESSING copies are never hung); the vendor fixture itself
covers every case and syntax. Identity tags are
replaced at serve time with the synthetic ones; pixels unchanged; `assets/dicomweb/ATTRIBUTION.md` lists collections,
DOIs and licences.

Design decisions: `evidence/studio-design-final-20261027.md` (D1–D11). Phase 1 = login, mirror (reading workflow
deep, other screens browsable), 바꾸기 (edit) + 되돌리기 (undo = `git revert`), critique (D4), 물어보기 (Q&A from
`status.json` + the repo), daily digest. Added 2026-10-28: two windows / overlay, point-and-click, the
"할 수 있는 것" showcase; the product window as an ordinary tab and the viewer as the product's popup; the admin
console against the mock; 먼저 제안하기 (Phase 2, proactive suggestions with pre-built previews). Captures and A/B are
Phase 2/3.

## What Minhoon sees

| Area | What it does |
|---|---|
| 보기: 두 창 (default) | `studio.html` is the chat only (portrait monitor); "제품 화면 열기" opens `product.html` in an ordinary Chrome tab named `minhoon-studio-product` (no window features, so it has the tab strip and bookmarks bar exactly like the product in real use; he drags the tab to the landscape monitor and maximises it). The viewer is not shown in that tab: as in the product (`viewer-launch.js`, `popup=yes` at the last or default viewer rectangle), the Viewer choice and the worklist's double-click open a separate popup viewer window; the studio adds `ui/viewer-studio.js` to its copy of the OHIF page, so either viewer joins the channel: it reloads once after a change, undo or reset (also after the chat tab was refreshed or reopened) and has the same corner widget and 고르기 as the product tab. Clicking again reuses and brings forward the same window; a chat tab that did not open it (another tab, or after a reload) asks it over the channel to come forward instead of opening a second one. The screen and role selectors in every chat tab follow what the product window reports. The product window has no studio bar, only a small fixed corner widget (connection dot + 고르기). The chat shows "제품 화면 연결됨 / 열려 있지 않습니다". The two windows talk over a same-origin `BroadcastChannel` (`minhoon-studio`): screen/role changes, reload after an applied change or undo, picks, heartbeat. |
| 보기: 한 창 (겹쳐 보기) | Single monitor: the product fills the window; the chat slides over the right edge (corner button "스튜디오" or Alt+S) and hides again without resizing the product. The choice is remembered per browser. |
| 고르기 (Alt+G) | Pick mode in the product: the element under the mouse is outlined; a click selects it ("선택됨 N"), several allowed, clicking again removes one, Esc clears all. A transparent shield takes the clicks and the keyboard focus, so the product's own buttons are never pressed (mouse, Space or Enter). Picks survive a reload and a re-sort: a row is named by its `data-uid`, a positional part only rebinds to the same visible text, and a pick that cannot be found shows as "화면에서 찾을 수 없음" instead of moving to another element. 고르기 from the chat with no product window opens it and starts picking there. Picks (selector, visible text, box, page, screen, role, font/colours) show as removable chips above the input and go to Claude with the next message ("이거 오른쪽으로"); the commit message records them. In the viewer popup the same shield covers the whole OHIF page (its clicks, wheel and keys never reach the viewer); a pick there also names its viewport (`data-viewport-uid`), series (UID, number, description, modality) and slice from OHIF's own services, shows as an "영상 창" chip and survives the viewer's reload. An image in an inactive viewport is picked as that image (OHIF is not activated). With several viewer popups open (the studio's and the worklist's) each keeps its own picks ("영상 창 1", "영상 창 2"); closing one drops only its own. One request carries at most 12 picks over all windows: the 13th click says so where he clicks, and everything shown is sent. 고르기 from the chat with the viewer open picks in the viewer (and the product tab) without bringing the product tab over the viewer. Agentation's pattern, written fresh (no code copied). |
| 할 수 있는 것 | Example cards shown on a person's first visit in a browser and from the tab bar; a click fills the input (or opens 기록 / points at the role selector / 오늘 끝). |
| 화면 / 역할 | Pick Worklist·판독, Clinician, Admin, Login 화면, or Viewer; switch the mock login role (radiologist/technician/clinician/admin). Role 관리자 opens Admin directly (in the product an admin lands on the worklist and reaches Admin through "Members"); leaving 관리자 returns to the worklist. Some role and lock rules are still open questions, so a role's screen is a prototype view, not a decision. |
| Admin (`server/mock-admin.js`) | Members (list, Create Member + temporary password, Approve / Change Membership with the unverified-email refusal and the in-person override, Revoke Approval, Suspend / Activate, Temp Password, version conflict and self rules), Signing Key (create / rotate / retire with the expected key), Study Access (modes, rules, revision, replayed request), Gateway Status (three synthetic receipts on finished readings: received, retry with Now Retry, failed F-01), Operations (the eleven metrics from the synthetic worklist), Audit / Security (seeded rows plus every studio admin change and report commit, paged) and Access Review (time range, file filter, paged). Not in the studio, said on screen: Email Reset Link (no mail server) and a study-access restriction on the studio person's own account. Synthetic members only; 합성 자료 초기화 resets them. |
| 바꾸기 | "판독문 입력칸을 더 크게" → Claude edits the front-end in the sandbox → build + syntax check → commit → product window reloads and reselects the same study (an edit that lands while he types in the product waits behind "지금 보기"). Bad requests get a short evidence-first objection; patient-safety/legal ones are refused and a safe alternative is built (D4). |
| 물어보기 | Read-only answers about the product and development status, with sources. Unknown dates/decisions are not guessed; the question is forwarded to the commander. |
| 먼저 제안하기 (`server/suggest.js`, `claude/suggest-system.md`) | While no chat tab reports typing (chat input, or a text field in the product) and no request is queued or running, the studio Claude (the "deep" model) reads the screen he is on, his last requests, his feedback (`knowledge/minhoon-feedback.md`) and the suggestions already answered, picks ONE improvement or criticism and builds it in `sandbox-preview/` (a git worktree of the sandbox; front-end only, no `studio-mock/`). The server checks the grounds (a feedback ground must name an existing item and quote that item as written, a quote is required; a screen ground naming a file must name one that exists; a named reading practice is accepted), builds and syntax-checks it like an edit and commits it to `refs/studio-preview/<id>`. The chat shows one card "제안: …" (근거 opens the reason and grounds) with 미리보기 / 적용 / 다른 제안 / 됐어요; it hides in every studio tab while anyone types in any studio tab or any request is queued or running (also during a preview, whose banner keeps 원래대로 / 적용; a tab opened meanwhile gets this state with its first event), and an answer older than what a tab shows is dropped. 미리보기 sets a cookie for this browser only, so the product window and an open viewer are served from the preview copy, each with one reload (both reload again when the preview ends, from the card or the banner) and a "미리보기 … 아직 적용하지 않은 제안" banner; 원래대로 ends it, and so does any request or undo of his own. 적용 applies the preview's source diff to the studio branch through the writer queue, rebuilds and checks it and commits it as an ordinary change (`Studio-Suggestion` trailer; 기록 and 되돌리기 work as for any change); if the screen moved on so that it no longer applies, the same request runs as an ordinary edit and the suggestion is recorded as applied only when that edit changes the screen (otherwise `apply-failed` / `apply-no-change`). A change made while a suggestion is open rebuilds its preview on top (or sets it aside when it no longer fits). Answered suggestions (and ones he saw before they were set aside) are not offered again; they are kept in `data/suggestions.json` for good, while other attempts are trimmed to the last 300. No frequency cap (D5: measure, then tune): one suggestion is open at a time and the next is prepared only after it is answered; a turn that finds nothing or fails waits for his next request or answer. Every suggestion, the card being shown, each preview (click → screen usable) and his answer go to `data/public/suggestions.jsonl` and the digest section "스튜디오가 먼저 한 제안과 답"; the Claude usage of each suggestion turn is in `usage.jsonl` (mode `suggest`). |
| 되돌리기 / 기록 | Undo the newest change, or any listed change; view each change's diff. An older change is undone together with the still-applied changes made after it (they were built on it; the studio asks first). Every undo is rebuilt and checked like an edit; if the check fails nothing is undone. |
| 현황 | The commander's `status.json` (everything except live secrets). |
| 오늘 끝 | Writes the digest now (also written after ~60 idle minutes). |
| Claude 빠르게/꼼꼼하게 | Sonnet (default, ~8–20 s per small edit) or Opus (~25–45 s, stronger judgement). |

## Server layout (pacs.koreaimagingnetwork.com, 61.109.239.207)

Everything is under `/opt/minhoon-studio`, run by the system user `studio` as the systemd unit `minhoon-studio`
on **port 8443** with the host's Let's Encrypt certificate for `pacs.koreaimagingnetwork.com` (owner decision
2026-10-28). The deployed PACS (nginx 80/443, Docker stack, Orthanc, Keycloak, DB) is not used, read or changed; the
unit cannot see the Docker socket or `/etc/nginx`.

Certificate: certbot keeps renewing the existing lineage unchanged. The deploy hook
`/etc/letsencrypt/renewal-hooks/deploy/minhoon-studio-cert` (source `deploy/minhoon-studio-cert`, installed by
`install.sh`) copies `fullchain.pem` + `privkey.pem` to `etc/tls/` (root:studio 0640) after each renewal of that
lineage and restarts the studio if it is running (a paused studio stays stopped). Copy by hand any time:
`sudo /etc/letsencrypt/renewal-hooks/deploy/minhoon-studio-cert`. On a host without that lineage `install.sh` falls
back to a self-signed certificate in `tls/`.

| Path | Owner | Content |
|---|---|---|
| `app/` | root (read-only) | this folder |
| `node/` | root | private Node 22.23.2 (not on the system PATH) |
| `bin/claude` → `home/.local/bin/claude` | studio | Claude Code CLI 2.1.284 |
| `claude-config/sdij`, `claude-config/admin` | studio | the two Claude logins (CLAUDE_CONFIG_DIR); empty until the owner logs in |
| `sandbox/` | studio | git repo: product tree at main `studio-base` + studio commits on `studio/minhoon-YYYYMMDD` (+ one `Studio-Kind: refresh` merge per new main) |
| `sandbox-read/` | studio | detached copy the 물어보기 Claude reads |
| `sandbox-preview/` | studio | detached copy where 먼저 제안하기 builds its previews (`refs/studio-preview/<id>`) |
| `assets/ohif`, `assets/dicomweb` | root | pinned OHIF build; static DICOMweb samples (TCIA + synthetic MG phantoms) |
| `*.bak-YYYYMMDD-HHMMSS-<pid>` | as the original | what an `install.sh` run replaced or copied first (app, assets, sandbox before a refresh, `data/mock-state.json`, `etc/config.json` when an account folder is added); one id per run, printed as `backup id:` — remove old ones by hand |
| `knowledge/status.json` | root | the commander's status feed (read-only for the service) |
| `knowledge/minhoon-feedback.md` | root | Minhoon's feedback the suggestions are grounded in (installed by the commander, not in this repo) |
| `data/` | studio | users/sessions (hashes only), chat, metrics, usage, mock state, `public/digests/`, `public/records.jsonl` |
| `etc/config.json`, `etc/studio.env` | root | config, written by `install.sh` only when absent and then the owner's (hand edits stay); `STUDIO_CLAUDE_ACCOUNT=admin` switches the Claude login |
| `etc/tls/` | root:studio 0750, files 0640 | copy of the Let's Encrypt fullchain + key (deploy hook) |
| `tls/` | studio | self-signed fallback (unused while `etc/tls/` is configured) |
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
   and `sudo systemctl restart minhoon-studio`. Any folder `claude-config/<name>` is an account
   (`STUDIO_CLAUDE_ACCOUNT=<name>`); `install.sh` adds a folder `etc/config.json` does not list yet to
   `claude.configDirs` (nothing else in the config changes) and stops if `studio.env` names one that does not exist.
   TLS paths, models and the default account in an existing config are not touched by a rerun; edit them by hand.

URL: `https://pacs.koreaimagingnetwork.com:8443/` (no certificate warning). `https://61.109.239.207:8443/` still
works but the browser warns, because the certificate names only the hostname. With the hostname the browser sends
the PACS cookies to port 8443 and the studio cookie `mstudio_sid` to the PACS (cookies are not port-scoped); each
side ignores the other's cookie by name and the studio never logs cookies.

## Commander

- **Publish status:** write `status.json` (schema in `knowledge-seed/status.json`: `published_at`, `next_publication`,
  `lanes`, `feedback`, `questions_*`, `decisions_concerning_minhoon`, `disagreements_open`, `estimates` labelled
  "추정", `usage`) and install it:
  `scp status.json ubuntu@61.109.239.207:/tmp/ && ssh ubuntu@61.109.239.207 'sudo install -m 644 /tmp/status.json /opt/minhoon-studio/knowledge/status.json'`.
  The page shows "갱신 지연" once `next_publication` has passed.
- **Publish Minhoon's feedback** (what 먼저 제안하기 grounds its suggestions in), the same way:
  `sudo install -m 644 /tmp/minhoon-feedback.md /opt/minhoon-studio/knowledge/minhoon-feedback.md`. Without it the
  suggestions still work from the screen, his requests and reading practice; feedback grounds are then refused.
- **Collect the digest:** `ssh ubuntu@61.109.239.207 'sudo tar -C /opt/minhoon-studio/data/public -czf - digests records.jsonl' > studio-digests.tgz`
  (`<day>.md` for people, `<day>.json` with requests/timings/usage, `<day>.patch` = cumulative diff vs main).
- **Collect the branch as commits:** `ssh ubuntu@61.109.239.207 'sudo -u studio git -C /opt/minhoon-studio/sandbox bundle create - studio-base..HEAD' > studio.bundle`
  then `git fetch studio.bundle HEAD:refs/studio/minhoon` locally (base = the main SHA in the `studio-base` commit message).
  Studio commits are not product history; reuse clean diffs only after the normal cross review against the real backend (D2/D3).
- **New main in the sandbox (refresh):** between sessions only (the refresh stops the unit while it merges; if the
  unit or a process of user `studio` is still running after the stop, the install stops before touching the sandbox). Build a
  bundle at the new main and rerun `install.sh <bundle>`; a `BASE_SHA` different from the sandbox's `studio-base`
  merges that main into Minhoon's branch (`deploy/make-sandbox.py --refresh`): every studio commit stays, the
  bundle/OHIF config are rebuilt, the merged files pass the chat's build/syntax check (`server/build.js`), and
  `studio-base` moves to the new main (old one: tag `studio-base-<sha12>`). The summary is
  `data/refresh-<sha>-<backup id>.json`. **A conflict (both sides changed the same lines), a failed builder, a failed
  syntax check, a failed commit/tag or any other error stops the install** with the sandbox put back (HEAD, branch,
  `studio-base` and every ref, index, files) and the conflicted files or errors in that JSON. A studio that was running
  is started again on the old sandbox only when the JSON says `sandbox_restored: true` and HEAD matches; otherwise it
  stays stopped for a person to inspect (`sandbox.<backup id>` is the copy from before the run). An install never
  starts a studio that was stopped before it (Pause below); only a first install starts it. Resolve by hand in a copy, then
  rerun. A changed `studio-mock/dataset.json` resets the mock state (drafts in the mirror); the old one stays as
  `data/mock-state.json.<backup id>`. Bundle, from the product checkout (`<b>` = an empty folder):
  ```powershell
  git fetch origin; $sha = git rev-parse origin/main; git archive --format=tar -o <b>/base.tar $sha; Set-Content <b>/BASE_SHA $sha
  git archive --format=tar.gz -o <b>/app.tgz HEAD:tools/minhoon-studio                     # the studio app (this folder)
  python tools/minhoon-studio/dev/extract_ohif.py --out <ohif>; tar -czf <b>/assets-ohif.tgz -C <ohif> .
  python tools/minhoon-studio/dev/build_dicomweb_store.py --mg-python <python with codecs> --out <store>; tar -czf <b>/assets-dicomweb.tgz -C <store> .
  scp -r <b> ubuntu@61.109.239.207:/tmp/studio-bundle
  ssh ubuntu@61.109.239.207 'mkdir -p /tmp/studio-app && tar -xzf /tmp/studio-bundle/app.tgz -C /tmp/studio-app && sudo bash /tmp/studio-app/deploy/install.sh /tmp/studio-bundle'
  ```
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
python tools/minhoon-studio/dev/build_dicomweb_store.py --mg-python <python>                 # static DICOMweb samples + MG phantoms
#   <python> has pydicom, numpy, imagecodecs and pyjpegls; EA1141 derivatives stay local (scripts/mgxa-acceptance.md)
python tools/minhoon-studio/test/refresh_test.py                                             # make-sandbox.py --refresh
python tools/minhoon-studio/deploy/make-sandbox.py --repo . --sha <main sha> --out <run>/sandbox
# config: copy deploy/install.sh's config block with Windows paths, "shellTool": "PowerShell", "python": "python"
node tools/minhoon-studio/server/server.js --config <run>/config.json                        # http://127.0.0.1:8443
node --test --test-force-exit tools/minhoon-studio/test/studio.test.js tools/minhoon-studio/test/flow.test.js tools/minhoon-studio/test/suggest.test.js
```
(`--test-force-exit`: a chat job keeps an hour-long cleanup timer, which would otherwise hold the test process open.)
Real-browser check of the chat/product window boundary (throwaway synthetic sandbox, Python Playwright, node on PATH):
`python tools/minhoon-studio/test/browser_check.py --out <folder> [--ohif <ohif-dist> --dicomweb <store>] [--headed]`
(`--headed` drives the installed Chrome in real windows and also compares the window chrome height of the product tab
with the chat tab). `--claude <claude.exe> --claude-config <logged-in CLAUDE_CONFIG_DIR> --feedback <feedback.md>` adds
the 먼저 제안하기 checks with real suggestions (three suggestion turns; the run then takes several minutes).
`dev/capture_fixtures.py` records what the screens ask a **synthetic** fixture stack, to refresh the mock shapes.
