# fjord-core

The [Fjord repository format](https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md) as a library: manifests, vault discovery, the path rules,
Fjord Docs and their frontmatter, `age` encryption with the `tar` container, three-way merge of text, and the diagnostics `fjord verify` reports, each with a stable code.

It is what [`fjord-cli`](https://crates.io/crates/fjord-cli) is built on, and what the web client and the other clients use (the web client compiles its pure subset to WebAssembly), so that no
client reimplements the format.

```toml
[dependencies]
fjord-core = "0.3"
```

- **Features.** The default, `native`, is everything. `crypto` is `age` and `tar` over bytes in memory. With neither (`default-features = false`) it is the pure subset: no disk, no clock,
  no random source of its own, which is what compiles to `wasm32-unknown-unknown`.
- **Frontmatter is untrusted input.** It is read by safe Rust (`serde-saphyr`, in `fjord_core::yaml`); unknown keys and their order survive a rewrite, and a block that cannot be written back exactly
  is reported and left alone.
- **Rust 1.89 or newer.**

Licence: MPL-2.0. The repository, the specification (CC0), the conformance fixtures every client must pass, and the issue tracker are at <https://github.com/sovereignfs/fjord>.
