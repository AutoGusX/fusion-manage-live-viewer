# Interpreting what the user asks for

Users are engineers, sales engineers and PLM admins. They type quickly, with typos, and they refer to things the way they'd say them across a desk. The goal is to act on the right thing the first time, and to ask one short question when you can't know.

## Contents
- Resolving references
- What the viewer can and can't tell you
- Viewer or Fusion Manage?
- When to ask and when to decide
- How to ask
- Reporting results

## Resolving references

| The user says | How to resolve it | If it doesn't resolve |
|---|---|---|
| A part or item number (`TA-1008`, `ASY-0005`) | `fmv fm find "<number>"`; `clearMatch` should be true | Say the number wasn't found and show near hits |
| A product name ("the turbine", "the desktop printer") | `fmv fm find "<name>"`, add `--ws` for the items workspace if results are noisy | List the top candidates with their numbers and ask. A nickname may not appear in FM at all |
| A kind of part in the loaded model ("the shaft", "the fans", "fasteners") | Search the BOM titles and `fmv view props --name "*word*"` | List the real parts that could fit ("there's no part called shaft; the parts on the axis are …") and ask |
| "This", "it", "the one I selected", "what I isolated" | `fmv view state` → `focus` | `focus` null: ask them to click the part or give its number |
| "The assembly", "the model", "the BOM" | The loaded model: `fmv status` shows its workspace and item | Nothing loaded: ask which item |
| "The change order", "that NC" | The record you last created or discussed in this conversation | If more than one fits, name them and ask |
| "Its children", "sub-assemblies", "everything under it" | The BOM, all levels: `fmv fm related` and `fmv fm bom --depth` cover this | — |
| A record type ("NCRs", "ECOs", "CAPAs", "deviations") | `fmv fm workspaces "<word>"`; try synonyms (non-conformance, corrective, change order, change request) | Show the workspace list and ask which one they mean |
| A person ("assign it to Maria") | The field's options: `fmv fm options <ws> <field> --filter "Maria"` | Several matches: ask which |

Typos are normal ("asselmbly", "hcnage order"). Read through them. Only ask when the typo makes two real things equally likely.

Two habits prevent most wrong turns:

- **Say what you resolved.** "Loading TA-1008 Turbine Assembly (Items)" in your first line lets the user stop you at once if it's the wrong one.
- **Don't introduce your own names.** If you grouped parts yourself, label the group by what it is in FM terms (a state, a record number, the part titles), because the user will reuse whatever words they see on screen.

## What the viewer can and can't tell you

The model in the viewer is a display mesh with a part tree and properties. That decides what you can answer.

| Request | Can do | Can't do, and what to say |
|---|---|---|
| "Show / isolate / highlight / colour / hide" | Yes | — |
| "Cross-section", "cut it open", "explode it" | Yes | — |
| "What is this part?" | Yes: name, part number, material, mass and other properties, then the FM record | — |
| "How big is it?", "what does it weigh?" | Properties if the model carries them (`fmv view property-names`) | No dimensions beyond what's in the properties |
| "Interference check", "do these clash?" | Only a rough look: section through the parts, take a screenshot, and describe what is visible | No computed clash volume. Say it is a visual check, not an analysis |
| "Should I change the tolerance?", "will it fit?" | Show the parts and their fit visually; gather part data and related records | The model has no tolerances, fits or GD&T. That call needs the CAD model or drawing; say so, and offer to find the drawing attachment |
| "Measure the gap" | No reliable measurement through the CLI | Suggest the measure tool in the viewer toolbar, which the user can operate themselves |
| "Change the model", "move this part" | No | The viewer is read-only; design changes happen in CAD |

When part of a request is out of reach, do the part you can, and state the limit in one sentence. Don't refuse the whole request, and don't present an approximation as an answer.

## Viewer or Fusion Manage?

Some words could mean either. The difference matters, because one is a throwaway display and the other is a company record.

| The user says | Default reading | Why |
|---|---|---|
| "Add a note", "make a note", "flag it", "mark this" | A note in the viewer (Notes panel plus `fmv note`) | Cheap, reversible, and visible straight away. Mention that it isn't saved to FM, and offer to save it there |
| "Add a comment to the item", "update the description", "log this on the record" | Fusion Manage write | They named the record. Draft, confirm, write |
| "Highlight", "colour", "label" | Viewer | Nothing in FM changes |
| "Create / raise / open a change order (NC, task…)" | Fusion Manage write | Draft with `--dry-run` first |
| "Release it", "approve it", "submit it", "cancel it" | Workflow transition in FM | Can notify people and lock records. Always confirm |
| "Delete it", "get rid of it" | Ask which they mean: clear it from the viewer, or archive the FM record | Archiving a record is rarely what a casual "delete" means |
| "Clean up" after a demo or test | Reset the viewer, and list any records you created so the user can choose to archive them | Don't archive records the user created themselves without asking |

## When to ask and when to decide

Decide yourself, and say what you chose, when the choice is cheap to undo: colours, camera angle, explode amount, panel titles, which CAD attachment to load when there's one obvious model, how deep to show a BOM.

Ask first when a wrong guess costs something:

- Which item or record, if `find` isn't clear.
- Any value in an FM record that the user didn't give: title, template, priority, reason, approvers, owner.
- Any workflow transition.
- Removing an item from another change order, or archiving a record you didn't create in this session.
- Which workspaces count as "non-conformances" or "quality records" on this tenant, when more than one could.

If the user has already answered ("use the Test - No Approvers template, priority medium"), don't ask again.

## How to ask

Users don't know FM's internal numbers, so a question like "is PRT-200 the one you meant?" tells them little. Describe each candidate in their terms (what kind of record it is, which workspace it lives in, whether it has a 3D model, its state) and recommend one:

> I found three records called Desktop Printer. The one I'd open is **PRT-200 Desktop Printer**, a top-level assembly in Items with a 3D model. The others are PRT-052 Desktop Printer (Items, no model) and PRD-035 Desktop Printer (the Products record). Shall I open PRT-200?

When the user only wants to *look* at something and exactly one candidate has a 3D model, load it, say which one you chose and why, and list the others so they can redirect you. When the next step would change a record, ask first.

One question, with the real options, so the user can answer in a word:

> There's no part named "shaft" in this assembly. The parts on the axis are **TA-1035 Turbine Axis Spacer**, **TA-1040 Front Turbine Hub**, **TA-1032 Rear Turbine Hub** and **TA-1039 Turbine Bearing**. Which do you mean, or all four?

> Change Orders needs a template. The options are Test - No Approvers, Fast Track, Mechanical Change Template… Which one?

Avoid open questions ("which part did you mean?") when you can list candidates, and avoid stacking several questions when one answer unlocks the rest.

## Reporting results

- Lead with what happened, in plain words: what is now on screen, what was created, what was found.
- Give record numbers with titles and states, and the `url` for anything the user may want to open.
- Give counts: parts matched and not matched, records scanned, rows failed.
- State limits once: what wasn't checked, what is approximate, what you assumed.
- If something failed, say so first, with FM's own message.
