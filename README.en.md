# dsh-turn-delete

English | [中文](README.md)

Delete one complete closed turn from a DeepSeek Harness conversation without deleting or replacing the Session. The action appears beside the final assistant response for each completed top-level turn.

> This repository is an **independent continuation** of [hanshenmesen/dsh-turn-delete](https://github.com/hanshenmesen/dsh-turn-delete). The upstream main branch has not merged this repository's compatibility fixes, so they are maintained here, tracking DeepSeek Harness `0.1.5-rc.2` surface rules.

## Demo

Delete the middle turn after confirmation while keeping the same Session and its later turn. Recorded through the real DeepSeek model flow on DeepSeek Harness `0.1.0-rc.7`; the interaction is the same in the current version.

![Delete one turn without deleting the Session](https://github.com/hanshenmesen/dsh-turn-delete/releases/download/v0.1.0/dsh-turn-delete-demo-en.gif)

## Behavior

- A trash action appears only on completed ordinary Session turns. Subagent transcripts do not expose it.
- Deletion requires confirmation and is disabled while the Session is running.
- **Immediate**: a successful deletion conceals the removed turn's rows in place, so the turn leaves the transcript without switching Sessions; the durable tombstone keeps it hidden on every later full render.
- A durable replacement event records the deletion. Reloading the page or restarting the profile preserves it.
- The Session's system-prompt node is never part of the removed span.
- The Session id, title, workspace association, later turns, and original append-only event log remain intact.
- Repeating the same request is idempotent.

The plugin refuses deletion when the target turn is still open or has already been folded into a compaction summary with other history: a summary is replaced as a whole, so one turn inside it cannot be removed on its own. That refusal is reported as such. An unexpected internal failure is reported as a failure with its reason — never as "the task is running".

## Install

From a local directory (development):

```sh
dsh plugin --profile web add -w link:/absolute/path/to/dsh-turn-delete
```

From GitHub (a private repository needs credentials on the machine):

```sh
dsh plugin --profile web add github:TiJun-Prime/dsh-turn-delete-dev
```

From a prebuilt GitHub Release (once a release exists):

```sh
dsh plugin --profile web add https://github.com/TiJun-Prime/dsh-turn-delete-dev/releases/latest/download/dsh-turn-delete.tgz
```

Restart `dsh web` after installation (restart the desktop app on a desktop shell). To remove it:

```sh
dsh plugin --profile web remove dsh-turn-delete
```

## Differences from upstream (0.2.0)

1. **DSH 0.1.5-rc.2 compatibility**: surface replacements use `{ op: 'replace', startSeq, endSeq }`, and the tombstone carrier changed from `assistant/message` to an **empty `system/message`** — 0.1.5 forbids `sourceEventSeqs` on `assistant/message`, while an empty system node both cites its sources and projects to no wire message. Tombstones written by older builds are still recognized.
2. **The system prompt is never part of the removed span**: 0.1.5's `assertSystemHeadRewrite` protects surface node 0, which a first turn's span could include.
3. **Honest error reporting**: internal failures (for example a changed kernel API) are no longer wrapped as `AGENT_BUSY`; `DELETE_FAILED` reports the real reason, and only a genuinely non-idle Agent reports "the task is running".
4. **Immediate concealment** after a delete: the chat's turn-tail row is not re-rendered by a live append, so the action conceals its own turn's rows directly.
5. **Tooling**: build/check scripts work on Windows (the `.bin` shim problem is fixed), and `npm run check` now smoke-tests the built host bundle against the real kernel through its HTTP route.

## Design

The Host half registers `POST /dsh-turn-delete`: it claims the target Agent's maintenance lease, validates the complete closed-turn surface span, appends a durable replacement, and waits for `sessions.flush()` before acknowledging success. The replacement is an empty `system/message` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` plus the `sourceEventSeqs` it shadows.

The browser half contributes to the public `conversation.chat.assistant-actions` and `conversation.chat.turnTail` slots. A Conversation definition projects the durable tombstone onto the target Turn's Location data, and a marker component hides the Chat rows between adjacent Turn tails. DeepSeek Harness does not yet expose a public whole-Turn visibility hook, so that presentation compatibility layer is row-scoped; model context deletion does not depend on it.

## Compatibility

- DeepSeek Harness `0.1.5-rc.2` (surface replacements use `{ op: 'replace', startSeq, endSeq }`)
- Node.js 22.19 or newer
- Web profile and Web-based desktop shells

DeepSeek Harness is in developer preview and changes its surface API between releases. After upgrading Harness, verify the plugin once with a disposable Session containing three short turns and delete the middle one.

## Development

```sh
npm install
npm run check
dsh plugin --profile web add -w link:/absolute/path/to/dsh-turn-delete
```

`npm run check` type-checks, builds both plugin halves, runs the unit/UI tests, smoke-tests the built host bundle against the real kernel through its HTTP route, and verifies the npm package contents.

## Security

Like every DSH plugin, this package runs with the Harness process's permissions. Review the source before installing third-party plugins. The deletion changes future model context but deliberately retains the original append-only events for audit and replay.

## License

MIT
