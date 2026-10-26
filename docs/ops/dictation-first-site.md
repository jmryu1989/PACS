# Dictation at a first site: configuration, limits, failure and recovery

Dictation sends a reader's recording to one internal speech-recognition engine and shows the
transcript for review; nothing reaches the report until the reader presses Insert. This page is
what an installer sets for a first site and what the reader sees when the engine is down or slow.
It does not choose or approve an engine deployment for a site: the approved ASR configuration and
real-use material are separate conditions (Part 1 re-plan). A green engine CI job is not dictation
acceptance either.

## Settings

All settings are environment values of the `api` service; `docker-compose.yml` passes them from
`.env`. Leaving `KIN_ASR_URL` empty keeps Dictate off. An empty value of any other key means "use
the default".

| Key | Value | Default |
|---|---|---|
| `KIN_ASR_URL` | `http(s)://<host>[:port]/inference` of the engine. `<host>` is a Compose service name, a hospital-internal DNS name (for example `asr.radiology.hospital.internal`) or a private/loopback/link-local IP. | empty (off) |
| `KIN_ASR_ENGINE` | `whisper.cpp@927cfce34f31707e17f2bff35c349632fb9e2c3a` (must match `ASR_ENGINE_PIN`) | none |
| `KIN_ASR_MODEL` | `ggml-small@sha256:1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` (must match `ASR_MODEL_PIN`) | none |
| `KIN_ASR_LANGUAGE` | `auto` or a 2-3 letter code (`ko`, `en`) | `auto` |
| `KIN_ASR_MAX_BYTES` | largest recording in bytes, header included (32,000 bytes per second + 44) | `5760044` (180 s) |
| `KIN_ASR_TIMEOUT_MS` | how long the API waits for one transcript, 1 to 240000 | `120000` |

A value outside its rule turns Dictate off and the API log says which setting is wrong
(`KIN_ASR_URL 설정 오류 …`). The engine and model values are configured labels; they do not prove
which binary or model actually runs (the engine CI job attests its own build only).

**Applying a change.** The values are read when the container is created, so after editing `.env` run
`docker compose up -d api proxy` and then `docker compose restart proxy`. The restart is needed even
when only the API changed: nginx resolved the API's address when it started, and a recreated API
container has a new one (on the synthetic stack every request then answered 502 until the proxy
restarted). Readers reload the page to pick up a changed limit or timeout.

**The engine the pins name.** For reference only (where and how a site runs its engine is the separately
approved ASR configuration): `tests/fixtures/asr/Dockerfile`, target `engine`, builds whisper.cpp at the
pinned commit and runs `whisper-server --host 0.0.0.0 --port 8080 --model /models/ggml-small.bin
--threads <cores>`; the model is `ggml-small.bin` from the pinned Hugging Face revision with SHA-256
`1be3a9b2…a987b` (the URL and full hash are in `.github/workflows/validate.yml`, job `asr-engine`).
The synthetic stack below ran exactly that image as a Compose service with a dotted network alias.

**Endpoint names (C24).** A name is accepted whatever its shape. What decides is the address it
resolves to when the API connects: every address must be private (10/8, 172.16/12, 192.168/16),
loopback, link-local or IPv6 ULA, checked on the connecting socket itself with no second lookup.
A name that resolves outside those ranges is refused and logged as a configuration error; no audio
is sent. A name that does not resolve at all (engine host off, DNS record missing) is treated as an
engine that is not there right now, not as a configuration error. (A resolver that answers unknown
names with a public address turns that case into the refusal: the address is what is checked.)

**Recording limit (C13).** The capture format is 16 kHz mono PCM16 WAV, 32,000 bytes per second.
The limit is `KIN_ASR_MAX_BYTES`; the reader sees it while recording ("최대 약 180초") and the
recording stops by itself at it. The only fixed bound is the WAV header's 32-bit size field
(4,294,967,303 bytes). The proxy's dictation location (`location ~* ^/api/studies/[^/]+/dictation/?$`)
admits the same setting: pass `KIN_ASR_MAX_BYTES` to the `proxy` service too (Compose does) and its
body limit becomes that value when it is above 32 MiB, otherwise 32 MiB. The browser keeps one
buffer of the configured size per recording, so a site that raises the limit should keep the
timeout and the engine's speed in step (below).

Related bounds that do not move with the setting: the transcript is accepted up to 16,384
characters (about 27 minutes of English at 600 characters a minute); the engine's answer up to
128 KiB; one transcription at a time per API (a second reader gets "다른 음성 인식이 처리 중입니다").

## What the reader sees when the engine is down or slow

The report text never changes before Insert, and nothing in this section touches the draft: what
the reader typed stays on screen and keeps being autosaved as the server draft.

| Situation | Pane | Recording |
|---|---|---|
| Engine process down, host reachable (connection refused) | 음성 인식에 실패했습니다 — 녹음은 이 화면에 남아 있고 판독문은 그대로입니다. 다시 보내려면 Retry, 버리려면 Cancel을 누르세요 | kept, Retry focused |
| Engine host name does not resolve (stopped Compose container, DNS outage) | same as above | kept |
| Engine does not answer within `KIN_ASR_TIMEOUT_MS` | 음성 인식 시간이 초과되었습니다 — 녹음은 … | kept |
| Another reader's transcription is running | 다른 음성 인식이 처리 중입니다 — 잠시 뒤 다시 시도하세요 — 녹음은 … | kept |
| API or proxy unreachable (network error, 502/503/504 without a dictation code) | 음성 인식 서버에 연결하지 못했습니다 / 음성 인식 요청이 거절되었습니다 (HTTP 5xx) — 녹음은 … | kept; Retry waits while the page is offline |
| No answer within the client's own deadline (`KIN_ASR_TIMEOUT_MS` + 5 s) | 음성 인식 응답이 없어 요청을 멈췄습니다 — 녹음은 … | kept |
| Configuration wrong or name resolves outside the internal ranges | 음성 인식기가 연결되지 않았습니다. — 판독문은 그대로입니다 | discarded (Close) |
| Recording too long, invalid audio, report held by another reader, role/institution refusal, empty or overlong transcript | that refusal's own message — 판독문은 그대로입니다 | discarded (Close) |

While a recording is held the session keeps its place (study, report version, field and caret).
Cancel, moving to another study, a changed report version and leaving the page discard it; it is
kept only in the page's memory (no storage, no file, no object URL). Each attempt is one
`dictation.request` audit row (bytes, seconds, server time, engine label, outcome; no audio or text).

**Recovery.** Nothing has to be restarted on the PACS side. When the engine answers again the
reader presses Retry (or Enter, since Retry has the focus) and the same recording is sent; a new
recording also works at once. The operator's trace is one API log line per failed engine request,
`음성 인식기 요청 실패: <cause>` (for example `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `timeout`,
`response`), and nothing when the reader left. A frozen engine (for example a paused container)
may first finish the request that timed out before it serves the retry: whisper.cpp runs one
inference at a time.

## Measured on the synthetic stack

Run `asr-first-site-ee42c7e-r4` (2026-10-26, rehearsal VM: 4 vCPU Intel Xeon Gold 5120 at 2.2 GHz,
16 GiB). Product SHA `ee42c7e`; `tests/e2e/test_dictation_first_site.py` on the served page in Chromium 148
(Playwright 1.60.0), whose file-backed fake microphone played a 109.9 s eSpeak English passage of 40
non-clinical sentences (`tests/dictation_first_site_passage.py`, looped by Chromium). Engine: the pinned
whisper.cpp and ggml-small with `--threads 4`, a Compose service reached as
`asr.radiology.kin-hospital.internal` (the C24 path). Limit and timeout unset (180 s, 120 s);
`KIN_ASR_LANGUAGE=en`.

| What | Result |
|---|---|
| Recording left running | stopped by itself at 180 s ("최대 녹음 길이에 도달해 녹음을 멈췄습니다 — 인식을 요청하는 중입니다"); 5,760,044 bytes on the wire; audit row `seconds` 180, `success` |
| Proxy | the dictation location admitted it (bound 32m); a 5,760,045-byte body got the API's 413 `DICTATION_AUDIO_TOO_LARGE` |
| Time to transcript, 180 s recording | 80.2 s from request to answer in the browser; 82.2 s on the server (68 % of the 120 s default) |
| Engine while transcribing | up to 398 % CPU (its 4 threads), memory 629 MiB median and 747 MiB peak (`docker stats` every 3 s) |
| Time to transcript, ~6 s recording | 7.7 s (the engine decodes at least one 30 s window) |
| Synthetic recognition, 180 s | 33 of 40 sentences word for word, 7 of the last 8 (2,891 characters) |
| Engine process down, name resolves | 503 `DICTATION_ENGINE_FAILED` after 0.24 s; recording held, Retry focused; API log `음성 인식기 요청 실패: ECONNREFUSED`; after the engine restarted Retry sent the same bytes and got the transcript in 7.7 s; Insert, Save and a reload kept the typed draft and the transcript |
| Engine container stopped, name gone | 503 `DICTATION_ENGINE_FAILED` after 0.47 s (`ENOTFOUND`), not a configuration error; held; Retry in 7.7 s |
| Engine frozen (paused) | the reader went on typing; 503 `DICTATION_TIMEOUT` after 120.2 s; held; once the engine ran again Retry answered in 13.9 s (it first finished the abandoned request); both the typed and the dictated text were saved |
| Stack without `KIN_ASR_*` | Dictate off; the existing live dictation path/geometry suite and the 26 dictation refusal cases pass with the new default and proxy location |

What this means for a first site: on this 4-vCPU host transcription took about 0.45 times the recording
length, so the 180 s default used two thirds of the 120 s timeout. An engine host slower than this, or a
raised limit, needs its own 180 s measurement (repeat test 01) and a `KIN_ASR_TIMEOUT_MS` to match (at most
240000; the proxy's read timeout is 300 s). While one recording is being transcribed, a second reader's
request gets "다른 음성 인식이 처리 중입니다" and keeps the recording for Retry.

## Not measured here (NOT_RUN)

- Real speech: a radiologist's voice, accent, speaking rate, vocabulary, microphone and room. The
  synthetic score above is clear eSpeak English; it says nothing about clinical dictation quality.
- Korean or mixed Korean/English dictation (`KIN_ASR_LANGUAGE=ko`/`auto`).
- How long first-site readers actually dictate. Re-check trigger: after the first weeks of use,
  read the `dictation.request` audit rows; recordings whose `seconds` equal the limit stopped at it,
  and `DICTATION_AUDIO_TOO_LARGE`/`DICTATION_TIMEOUT` outcomes show a limit or timeout that is short.
- The first site's engine host (CPU/GPU, threads, memory) and its transcription time; repeat the
  180 s measurement there before setting `KIN_ASR_TIMEOUT_MS`.
- Physician acceptance.
