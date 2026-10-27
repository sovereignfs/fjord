# The Fjord Web image (clients/web/DESIGN.md §17). Build it from the root of the repository, because the
# format module is built from `crates/`:
#
#   docker build -f clients/web/Dockerfile -t fjord-web .
#
# Four stages: the format module (Rust, to WebAssembly), the editors' package (TypeScript, built), the app (Node, a
# self-contained Next.js server) and a small runtime with none of the toolchains in it.

ARG NODE_VERSION=24
ARG RUST_VERSION=1.91

# --- The format module: fjord-core's pure subset as WebAssembly (crates/fjord-wasm) -----------------------------
FROM rust:${RUST_VERSION}-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown

# The command line tool must be the version the crate's lockfile names. Installed from the lockfile alone, so
# this layer is rebuilt only when that version changes and not whenever the sources do.
COPY crates/fjord-wasm/Cargo.lock /build/lock/Cargo.lock
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    want="$(grep -A1 '^name = "wasm-bindgen"$' /build/lock/Cargo.lock | sed -n 's/^version = "\(.*\)"$/\1/p')" \
    && cargo install wasm-bindgen-cli --version "=${want}" --locked

COPY Cargo.toml /build/Cargo.toml
COPY crates/fjord-core /build/crates/fjord-core
COPY crates/fjord-wasm /build/crates/fjord-wasm
WORKDIR /build/crates/fjord-wasm
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/crates/fjord-wasm/target \
    ./build.sh

# --- The editors' package (packages/fjord-editor) -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS editor
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build/packages/fjord-editor

COPY packages/fjord-editor/package.json packages/fjord-editor/pnpm-lock.yaml packages/fjord-editor/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages/fjord-editor/ ./
RUN pnpm build

# --- The app ---------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# The app links the editors' package from `../../packages/fjord-editor` (package.json), so the two sit where they do in the
# repository. The package is built, and keeps its node_modules: the bundler resolves the editors' own imports (CodeMirror)
# from there, as it does in a checkout.
COPY --from=editor /build/packages/fjord-editor /build/packages/fjord-editor
WORKDIR /build/clients/web

# Dependencies first, from the lockfile alone, so they are not fetched again for a change to the source.
COPY clients/web/package.json clients/web/pnpm-lock.yaml clients/web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY clients/web/ ./
# `FJORD_STANDALONE` makes `next build` write a server that carries what it needs (next.config.ts). Its bundler root is the
# repository's, so the server comes out under `clients/web/` in the output.
RUN FJORD_STANDALONE=1 pnpm build

# --- What runs -------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Fjord Web" \
      org.opencontainers.image.description="The hosted web client for Fjord" \
      org.opencontainers.image.source="https://github.com/sovereignfs/fjord" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FJORD_WASM_DIR=/app/wasm

WORKDIR /app
# The standalone server is `clients/web/server.js` with what it needs beside it; it changes into its own directory.
COPY --from=app /build/clients/web/.next/standalone ./
COPY --from=app /build/clients/web/.next/static ./clients/web/.next/static
# Read at start-up from the working directory (src/db/migrate.ts), so they are files, not part of the bundle.
COPY --from=app /build/clients/web/migrations ./clients/web/migrations
COPY --from=wasm /build/crates/fjord-wasm/pkg/node ./wasm
# The module is CommonJS and this app's package.json says `"type": "module"`, which would make Node read it as ESM.
RUN echo '{"type":"commonjs"}' > ./wasm/package.json

# Licences travel with the image: ours, and the design system's NOTICE, which carries Lucide's ISC licence
# and asks that it accompany copies (a standalone build prunes it).
COPY --from=app /build/clients/web/LICENSE /usr/share/licenses/fjord-web/LICENSE
COPY --from=app /build/clients/web/node_modules/@sovereignfs/ui/LICENSE /usr/share/licenses/sovereignfs-ui/LICENSE
COPY --from=app /build/clients/web/node_modules/@sovereignfs/ui/NOTICE /usr/share/licenses/sovereignfs-ui/NOTICE
# The editors' package is MPL-2.0 and is part of the server's bundle, so its licence travels too.
COPY --from=editor /build/packages/fjord-editor/LICENSE /usr/share/licenses/fjord-editor/LICENSE
# What the editors are built on (CodeMirror, MDXEditor, Lexical and the rest of their closure) is permissively licensed
# and asks that its notice accompany copies; the package writes them into one file when it is built.
COPY --from=editor /build/packages/fjord-editor/dist/THIRD_PARTY_NOTICES.txt /usr/share/licenses/fjord-editor/THIRD_PARTY_NOTICES.txt

# The database file, when the instance keeps one (SQLITE_URL=file:/data/fjord.db), and nothing else, is written.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "clients/web/server.js"]
