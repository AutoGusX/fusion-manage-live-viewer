# Set up (instructions for Claude Code)

The plugin is already installed if you are reading this from it. These steps get the viewer running for this user. Follow them in order. `fmv` below means `node <plugin root>/bin/fmv.js`, where the plugin root is the folder containing this file.

The user must bring their own APS client ID and Fusion Manage tenant. Nothing is preconfigured. Never suggest or reuse anyone else's values.

## 1. Check Node

Run `node --version`. Version 22 or newer is required. If it's missing or older, stop and tell the user to install the current LTS from https://nodejs.org. Don't install it for them.

Check the CLI runs: `fmv help`. There are no dependencies to install; `npm install` is not needed.

## 2. APS app and tenant access (the user does this)

Tell the user they need:

1. An APS app at https://aps.autodesk.com/myapps of type **Desktop, Mobile, Single-Page App**, with callback URL **`http://localhost:4710/callback`** (exact match). There is no client secret.
2. Their Fusion Manage admin to add that app's client ID under **Allowed client IDs**: `https://<tenant>.autodeskplm360.net/plm/admin/system-configuration/general-settings`.

`fmv checklist` prints this once the config exists.

## 3. Config (the user types the values)

Ask the user to type `! fmv setup` in the Claude Code prompt (with the full `node …/bin/fmv.js setup` path if `fmv` isn't on their PATH). It asks for the client ID and tenant and saves them to `~/.fusion-manage-live-viewer/.env`. Then run `fmv setup --check`; every line should say `ok`.

Don't read or print the `.env` file, and don't ask the user to paste the values into the chat.

## 4. Start and sign in

```bash
fmv start               # opens http://localhost:4710 in the browser
fmv login --no-wait     # opens the Autodesk sign-in page; the user signs in
fmv status              # after the user says they are done
```

If the first Fusion Manage call reports `FM_CLIENT_NOT_ALLOWED`, step 2.2 isn't done yet.

## 5. Smoke test

```bash
fmv fm workspaces --json                 # a list of workspaces
fmv note "Live viewer installed"         # shows in the Activity panel
```

## 6. Keep the config out of transcripts (with the user's OK)

Suggest this deny rule for the user's `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.fusion-manage-live-viewer/**)"] } }
```

## Optional: `fmv` on the PATH

From the plugin root, `npm link` adds a global `fmv` command. Ask first; it changes the user's global npm folder.

## Upgrade

Update the plugin (`/plugin update fusion-manage-live-viewer`), then `fmv stop` and `fmv start`. Config and sign-in are kept.
