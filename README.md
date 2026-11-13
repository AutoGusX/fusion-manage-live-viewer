# Fusion Manage live viewer

A Claude Code plugin that lets Claude work in Autodesk Fusion Manage and drive a local 3D viewer while it does. Claude loads models from Fusion Manage items, highlights, colours, sections and explodes parts, and shows BOMs, tables, notes and record cards beside the model. It can also find records, trace change orders and non-conformances across a BOM, and create, edit and transition records, with a preview before every write.

This is an unofficial personal project, not an Autodesk product.

- **You bring your own APS client ID and Fusion Manage tenant.** Nothing is preconfigured or shared. Your values live in `~/.fusion-manage-live-viewer/.env` on your machine, never in this repo.
- **No MCP server.** Claude drives everything with the `fmv` CLI from its shell.
- **No uploads or translation credits.** Models come from Fusion Manage's own derivatives of the attachment.
- **No dependencies.** Node 22 or newer and a browser are all it needs.

## Install

In Claude Code:

```
/plugin install fusion-manage-live-viewer --marketplace AutoGusX/fusion-manage-live-viewer
```

Then tell Claude: *"Set up the Fusion Manage live viewer."* It follows [INSTALL.md](INSTALL.md).

## What you need first

1. **Node 22 or newer.**
2. **Your own APS app** at https://aps.autodesk.com/myapps, of type *Desktop, Mobile, Single-Page App*, with the callback URL `http://localhost:4710/callback` (exact match). It is a public PKCE client, so there is no client secret.
3. **Your Fusion Manage tenant name** (the part before `.autodeskplm360.net`), and a tenant admin who adds your app's client ID under *Allowed client IDs* in General Settings.

You type the client ID and tenant into `fmv setup` yourself. Claude never sees or stores them in the conversation.

## What it looks like in use

> "Open the turbine assembly TA-1008, isolate the bearing and show me the BOM."
>
> "Which change orders and non-conformances touch this printer or anything in its BOM? Highlight the affected parts."
>
> "Raise a change order for the parts I have isolated."

Claude asks before it writes to Fusion Manage, shows a draft first, and reports what Fusion Manage shows afterwards.

## How it works

```
Claude Code ──fmv──► local server (127.0.0.1:4710) ──SSE──► browser tab (APS Viewer + panels)
                        │  PKCE sign-in, token refresh             │
                        └──► Fusion Manage API       ◄── results, selection events
```

The server binds to localhost only. Your Autodesk token stays inside it: Claude calls Fusion Manage through `fmv fm …` and never handles the token.

- Commands: `fmv help`
- The guide Claude follows: [skills/fusion-manage-live-viewer/SKILL.md](skills/fusion-manage-live-viewer/SKILL.md)
- Design: [specs/](specs/). Open work: [BACKLOG.md](BACKLOG.md)

## Without the plugin system

```bash
git clone https://github.com/AutoGusX/fusion-manage-live-viewer.git
cd fusion-manage-live-viewer
node bin/fmv.js setup      # your APS client ID and tenant
node bin/fmv.js start
node bin/fmv.js login
```

Copy `skills/fusion-manage-live-viewer/` to `~/.claude/skills/` so Claude knows the commands.

## Development

```bash
npm test        # unit and integration tests (stub APS and Fusion Manage, simulated browser tab)
```
