# Fjord for Claude — 1e — Distribution

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1e.1 Desktop extension

**Status:** 📋 Planned

**Design:** §11

An `.mcpb` bundling the binaries, with sign-in from its settings.

**Accepts when:** One-click install in Claude Desktop on macOS and Windows; tools work after sign-in.

## 1e.2 Binaries and Homebrew

**Status:** 📋 Planned

**Design:** §11

Cargo-dist, the tap.

**Accepts when:** `brew install sovereignfs/tap/fjord-mcp` works; checksums published.

## 1e.3 Documentation

**Status:** 📋 Planned

Setting up Claude Code, Claude Desktop and claude.ai; what each tool does; what is never a tool and why.

**Accepts when:** A new user follows it to a first saved document on each surface.

## 1e.4 First release

**Status:** 📋 Planned

`mcp-v0.1.0` through the release flow.

**Accepts when:** Binaries, the extension and the image are published; the tag is not *Latest*.
