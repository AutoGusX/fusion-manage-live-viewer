# Troubleshooting

Start with `fmv status`. It shows whether the server is running, whether the user is signed in, whether the viewer tab is connected, and which model is loaded.

| Symptom | Cause | Fix |
|---|---|---|
| `NOT_RUNNING` | The local server isn't started | `fmv start` |
| `CONFIG_INVALID` | No config yet, or it is incomplete | Ask the user to run `! fmv setup` themselves (it prompts for the APS client ID and tenant). Check with `fmv setup --check`, which masks values |
| `PORT_IN_USE` | Something else is on the port | The hint explains how to change `FMV_PORT`; the APS app's callback URL must change to match |
| `AUTH_REQUIRED` | Not signed in, or the session expired | Run `fmv login --no-wait` yourself; it opens the sign-in page (or prints a link to pass on) and returns at once. Ask the user to sign in, then check `fmv status`. Plain `fmv login` waits up to 5 minutes for them, which usually outlasts a command timeout |
| `fmv login` prints a link instead of opening a browser | No desktop browser is available, or `FMV_NO_BROWSER=1` is set | Give the user the link to open themselves; `fmv status` shows when they have signed in |
| Sign-in page shows an Autodesk error about the redirect or client | The APS app's callback URL or type is wrong | The app must be type *Desktop, Mobile, Single-Page App* with callback `http://localhost:4710/callback` exactly (`fmv checklist` prints this) |
| `FM_CLIENT_NOT_ALLOWED` on the first FM call | The tenant doesn't accept this APS client ID yet | An FM admin adds the client ID under *Allowed client IDs* in General Settings; the hint has the link |
| `VIEWER_NOT_CONNECTED` | The viewer tab is closed | `fmv open`, wait a few seconds, retry |
| Commands succeed but the user sees nothing change | Two tabs are open, and commands go to the newest | Ask the user to close the extra tab, or reload the one they are looking at |
| `TIMEOUT` on a viewer command | The tab is in the background and the browser paused it, or a huge model is still loading | Ask the user to bring the tab to the front; retry |
| `NOT_TRANSLATED_YET` | FM is preparing the file for viewing | Wait and repeat the same `load`. First view of a large assembly can take several minutes |
| `LOAD_FAILED` or `VIEWER_ACCESS_DENIED` | The token can't read the derivative, or the file is damaged | `fmv login` again; if it persists, open the file in FM itself to check it |
| `WEBGL_UNAVAILABLE` | The browser can't do 3D (remote desktop, disabled acceleration) | Use a current Chrome, Edge or Firefox with hardware acceleration on |
| `matched: 0` when colouring or isolating | The model's properties don't hold the value used | Follow the matching ladder in SKILL.md: `Part Number`, then name prefix, then `fmv view property-names` |
| A part count that looks far too low after `load` | The page is running an old script | Reload the tab, or `fmv stop` then `fmv start` (the tab reloads itself) |
| `/api/v3/…` arguments rejected as `INVALID_PATH` showing a `C:/…` path | Git Bash on Windows rewrote the argument | Current versions undo this automatically; otherwise drop the leading slash (`api/v3/…`) |
| A file written to `/tmp` isn't found by `fmv` on Windows | The shell and Node map `/tmp` differently | Write data files in the working folder and pass a relative path (`@body.json`) |
| `FILE_EXISTS` on download or screenshot | The CLI won't overwrite by default | Pick another name or add `--force` |
| Token or secret needed for some other tool | — | Don't read `~/.fusion-manage-live-viewer/`. Route the call through `fmv fm` instead. Raw token export exists only if the user enabled `FMV_ALLOW_TOKEN_EXPORT` |

## After upgrading

`git pull`, then `fmv stop` and `fmv start`. The open tab reloads itself when the server restarts; config and sign-in are kept.

## Where the log is

The server writes a redacted log to `server.log` in the config folder. Don't open that folder yourself. If an `INTERNAL` error needs diagnosing, ask the user to share the last lines of the log.
