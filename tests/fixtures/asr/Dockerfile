# S3-ASR-U3 hosted fixtures. CI-only; never built, pulled or run on a developer machine and
# never part of the product image. Two targets:
#
#   generator — eSpeak NG built from the pinned upstream tag, used once to synthesise the pinned
#               non-clinical sentence. No model, no recognition, no recorded human speech.
#   engine    — whisper.cpp built from the pinned commit, serving POST /inference.
#
# Both bake /kin-provenance.json at build time. scripts/asr_engine_attest.py reads those files
# with `cat` and refuses to let the workflow start the engine when anything fails to match.
#
# The engine target keeps its build tree rather than copying the binary into a slim stage: the
# cmake build emits ggml/whisper shared objects beside it, and an incomplete copy would fail at
# run time instead of at build time.

# ----------------------------------------------------------------------------------- generator
FROM debian:bookworm-slim AS generator

ARG ESPEAK_TAG=1.52.0
ARG ESPEAK_REPO=https://github.com/espeak-ng/espeak-ng.git
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git make autoconf automake libtool pkg-config build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src/espeak-ng
RUN set -eu; \
    git init -q .; \
    git remote add origin "$ESPEAK_REPO"; \
    git fetch -q --depth 1 origin "refs/tags/$ESPEAK_TAG:refs/tags/$ESPEAK_TAG"; \
    git checkout -q "refs/tags/$ESPEAK_TAG"

# Only the optional external audio/voice libraries are switched off. No synthesiser is disabled,
# and autoconf merely warns on an unknown --with option, so a renamed flag cannot silently change
# the build into something else.
RUN set -eu; \
    test -x ./autogen.sh; \
    ./autogen.sh; \
    ./configure --prefix=/usr --without-mbrola --without-sonic --without-pcaudiolib; \
    make; \
    make install; \
    ldconfig; \
    espeak-ng --version

RUN set -eu; \
    mkdir -p /kin; \
    git -C /src/espeak-ng rev-parse HEAD > /kin/commit; \
    git -C /src/espeak-ng rev-parse "refs/tags/$ESPEAK_TAG" > /kin/tag_object; \
    printf '%s' "$ESPEAK_TAG" > /kin/tag; \
    command -v espeak-ng > /kin/path; \
    sha256sum "$(cat /kin/path)" | cut -d' ' -f1 > /kin/binsha; \
    espeak-ng --version 2>&1 | head -n 1 | tr -d '"\\' > /kin/version; \
    sha256sum /src/espeak-ng/configure.ac | cut -d' ' -f1 > /kin/configure_sha; \
    printf '{"name":"espeak-ng","source":{"repository":"%s","tag":"%s","tag_object":"%s","commit":"%s","configure_ac_sha256":"%s"},"binary":{"path":"%s","sha256":"%s","version_banner":"%s"},"build":{"commands":["./autogen.sh","./configure --prefix=/usr --without-mbrola --without-sonic --without-pcaudiolib","make","make install"]}}\n' \
      "$ESPEAK_REPO" "$(cat /kin/tag)" "$(cat /kin/tag_object)" "$(cat /kin/commit)" \
      "$(cat /kin/configure_sha)" "$(cat /kin/path)" "$(cat /kin/binsha)" "$(cat /kin/version)" \
      > /kin-provenance.json; \
    cat /kin-provenance.json

# One pinned, non-clinical, entirely synthetic sentence. Never a recording, never clinical text.
COPY generate.sh /usr/local/bin/kin-generate
# The repository has no `text eol=lf` rule for this path, and a CR in the shebang would fail as
# "no such file or directory". Normalize here rather than depend on a checkout setting, then
# refuse to ship a script that does not parse.
RUN sed -i 's/\r$//' /usr/local/bin/kin-generate \
 && chmod 0755 /usr/local/bin/kin-generate \
 && sh -n /usr/local/bin/kin-generate

ENTRYPOINT ["/usr/local/bin/kin-generate"]

# -------------------------------------------------------------------------------------- engine
FROM debian:bookworm-slim AS engine

ARG WHISPER_TAG=v1.9.4
ARG WHISPER_COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
ARG WHISPER_REPO=https://github.com/ggml-org/whisper.cpp.git
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git cmake build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src/whisper.cpp
# The tag is fetched so that the tag -> commit binding is proved here and not merely declared.
RUN set -eu; \
    git init -q .; \
    git remote add origin "$WHISPER_REPO"; \
    git fetch -q --depth 1 origin "refs/tags/$WHISPER_TAG:refs/tags/$WHISPER_TAG"; \
    test "$(git rev-parse "refs/tags/$WHISPER_TAG^{commit}")" = "$WHISPER_COMMIT"; \
    git checkout -q "$WHISPER_COMMIT"; \
    test "$(git rev-parse HEAD)" = "$WHISPER_COMMIT"

# The official quick-start build. --convert is never enabled, so no ffmpeg is installed and the
# server only accepts audio it can decode itself.
RUN set -eu; \
    cmake -B build -DCMAKE_BUILD_TYPE=Release; \
    cmake --build build -j"$(nproc)" --config Release; \
    test -x /src/whisper.cpp/build/bin/whisper-server

RUN set -eu; \
    bin=/src/whisper.cpp/build/bin/whisper-server; \
    printf '{"name":"whisper.cpp","source":{"repository":"%s","tag":"%s","tag_object":"%s","commit":"%s","files":{"examples/server/server.cpp":"%s","examples/server/README.md":"%s","examples/common-whisper.cpp":"%s","src/whisper.cpp":"%s"}},"binary":{"path":"%s","sha256":"%s"},"build":{"commands":["cmake -B build -DCMAKE_BUILD_TYPE=Release","cmake --build build -j --config Release"],"ffmpeg_converter":false}}\n' \
      "$WHISPER_REPO" "$WHISPER_TAG" \
      "$(git rev-parse "refs/tags/$WHISPER_TAG")" "$(git rev-parse HEAD)" \
      "$(sha256sum examples/server/server.cpp | cut -d' ' -f1)" \
      "$(sha256sum examples/server/README.md | cut -d' ' -f1)" \
      "$(sha256sum examples/common-whisper.cpp | cut -d' ' -f1)" \
      "$(sha256sum src/whisper.cpp | cut -d' ' -f1)" \
      "$bin" "$(sha256sum $bin | cut -d' ' -f1)" \
      > /kin-provenance.json; \
    cat /kin-provenance.json

ENTRYPOINT ["/src/whisper.cpp/build/bin/whisper-server"]
