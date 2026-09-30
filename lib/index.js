import { MessageId, createSystemMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";

//#region src/shared.ts
const TURN_DELETE_PATH = "/dsh-turn-delete";
/**
* Identity stamped on every deletion tombstone.
*
* Session format v3 wrote the bare `source.plugin` of a `system/message`; the
* legacy `assistant/message` tombstones (DSH <= 0.1.2 era) used it as the
* provider instead, so one constant covers every generation.
*/
const TOMBSTONE_PLUGIN = "dsh-turn-delete";
/**
* Source kind session format v4 (DSH 0.2.x) forces on every `system/message`.
*
* v4 validates message sources by *role*, not by producer: a system message must
* be `system-prompt`, an assistant message must be `model` plus provider/model
* ("seed system/message … message must have system-prompt source"). The v3→v4
* migration additionally rejects the legacy bare `plugin` kind outright ("format
* v4 message requires a producer-owned source kind"). A v4 deletion tombstone
* therefore carries no producer identity in its source — an empty system
* replacement *is* the tombstone — while v3 keeps `source.plugin`, because the
* 0.1.x seed validator demands it ("seed system/message … message must have
* plugin source").
*/
const SYSTEM_PROMPT_SOURCE_KIND = "system-prompt";
/** Legacy tombstone provider (`assistant/message` tombstones only). */
const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN;
/** Legacy tombstone model (`assistant/message` tombstones only). */
const TOMBSTONE_MODEL = "tombstone";

//#endregion
//#region src/turn-delete.ts
var TurnDeleteError = class extends Error {
	name = "TurnDeleteError";
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
/**
* Whether one event is a turn-deletion tombstone written by this plugin.
*
* Current kernels write a `system/message` replacement: it is the only surface
* event type that both cites `sourceEventSeqs` (required to shadow a range) and
* projects to no wire message (empty system content is dormant). Session format
* v4 (DSH 0.2.x) forces `source.kind === "system-prompt"` on every system message
* (measured against the real 0.2.0-rc.1 kernel), so on v4 an empty system
* replacement is the tombstone by construction; v3 and pre-0.2 tombstones also
* carry our identity, which those formats do allow. DSH 0.1.5 forbids
* `sourceEventSeqs` on `assistant/message`, so the older tombstone shape is
* read-only replay compatibility: recognizing it keeps old deletions idempotent
* and keeps them hidden in the browser.
*/
function isTurnDeleteEvent(event) {
	if (event.type !== "system/message" && event.type !== "assistant/message") return false;
	if (!isReplacementSurfaceEvent(event)) return false;
	const message = event.data.message;
	if (message.content.length !== 0) return false;
	const source = message.source;
	if (event.type === "system/message") {
		const stamped = source;
		return stamped.kind === SYSTEM_PROMPT_SOURCE_KIND || stamped.kind === "plugin" && stamped.plugin === TOMBSTONE_PLUGIN;
	}
	return source.kind === "model" && source.provider === TOMBSTONE_PROVIDER && source.model === TOMBSTONE_MODEL;
}
/**
* Session format that validates message sources by role instead of by producer.
*
* Format 4 (DSH 0.2.x) requires `system-prompt` on every `system/message` and
* rejects the legacy bare `plugin` kind at admission, while the 0.1.x seed
* validator requires exactly the opposite ("seed system/message … message must
* have plugin source"). The tombstone therefore has to match the log it lands in.
*/
const ROLE_SOURCE_FORMAT = 4;
/**
* Source stamped on a deletion tombstone for one session format version.
*
* Format 4+ carries no producer identity: an empty system replacement is the
* tombstone by construction. Older logs keep our identity in `source.plugin`,
* which their validators demand. Exported for tests and hosts; see
* {@link ROLE_SOURCE_FORMAT}.
*/
function tombstoneSource(formatVersion) {
	return formatVersion !== void 0 && formatVersion >= ROLE_SOURCE_FORMAT ? { kind: SYSTEM_PROMPT_SOURCE_KIND } : {
		kind: "plugin",
		plugin: TOMBSTONE_PLUGIN
	};
}
function sessionFormatVersion(session) {
	const version = (session?.header)?.version;
	return typeof version === "number" && Number.isFinite(version) ? version : void 0;
}
/**
* Build the deletion tombstone message for one session.
*
* `createSystemMessage` also changed shape across kernel lines: 0.1.x takes the
* plugin name and emits `{ kind: "plugin", plugin }`, 0.2.x takes no plugin and
* emits `{ kind: "system-prompt" }`. Both are overridden here, so the source
* always matches the session's own format (the message is rebuilt as a plain
* object because kernel messages are frozen). The extra argument satisfies the
* 0.1.x signature and is ignored by 0.2.x.
*/
const createSystemMessageCompat = createSystemMessage;
function createTombstoneMessage(session) {
	return {
		...createSystemMessageCompat("", TOMBSTONE_PLUGIN),
		source: tombstoneSource(sessionFormatVersion(session))
	};
}
function eventTurn(event) {
	if (event.type === "assistant/message" || event.type === "tool/result") return event.data.turn;
}
/**
* Read a Session's event array.
*
* DSH 0.1.2-alpha.1 removed the `Session.events` property; the public API is
* `snapshotEvents()` (plus `ownEvents()` / `eventAt(seq)`). Reading through
* this helper keeps one build readable on both kernels.
*/
function sessionEvents(session) {
	if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
	return session.events ?? [];
}
function turnBracket(events, turn, targetSeq) {
	const start = events.findLast((event) => event.seq <= targetSeq && event.type === "turn/start" && event.data.turn === turn);
	const end = events.find((event) => event.seq >= targetSeq && event.type === "turn/end" && event.data.turn === turn);
	return start === void 0 || end === void 0 ? void 0 : {
		start: start.seq,
		end: end.seq
	};
}
function originBelongsToTurn(event, turn, bracket) {
	return event.seq > bracket.start && event.seq < bracket.end || eventTurn(event) === turn;
}
/**
* Whether one event carries the Session's system-prompt state rather than turn
* content.
*
* The kernel appends the system prompt lazily, so the first turn's bracket can
* contain surface node 0. Node 0 is protected: a replacement spanning it is
* rejected unless it is a single-node `system/message` replacement, and the
* prompt is infrastructure the Session must keep. Excluding system nodes from
* the turn's origin set keeps the prompt out of the replaced span while the
* remaining turn nodes stay contiguous.
*/
function isSystemPromptEvent(event) {
	return event.type === "system/message";
}
function surfaceOrigins(seq, events, memo, visiting = /* @__PURE__ */ new Set()) {
	const cached = memo.get(seq);
	if (cached !== void 0) return cached;
	if (visiting.has(seq)) return /* @__PURE__ */ new Set();
	visiting.add(seq);
	const event = events[seq];
	const origins = /* @__PURE__ */ new Set();
	if (event !== void 0) {
		if (isAppendSurfaceEvent(event)) origins.add(seq);
		const sources = event.sourceEventSeqs ?? [];
		for (const source of sources) for (const origin of surfaceOrigins(source, events, memo, visiting)) origins.add(origin);
	}
	visiting.delete(seq);
	memo.set(seq, origins);
	return origins;
}
async function deleteUnderMaintenance(ctx, agent, assistantMessageId, signal) {
	signal.throwIfAborted();
	const session = agent.session;
	if (ctx.sessions.get(session.id) !== session) throw new TurnDeleteError("TARGET_NOT_FOUND", `session "${session.id}" is no longer live`);
	const events = sessionEvents(session);
	const target = events.find((event) => event.type === "assistant/message" && isAppendSurfaceEvent(event) && event.data.message.id === assistantMessageId);
	if (target === void 0) throw new TurnDeleteError("TARGET_NOT_FOUND", `assistant message "${assistantMessageId}" was not found`);
	const turn = target.data.turn;
	const existing = events.find((event) => isTurnDeleteEvent(event) && event.data.turn === turn);
	if (existing !== void 0) return {
		turn,
		seq: existing.seq
	};
	const bracket = turnBracket(events, turn, target.seq);
	if (bracket === void 0) throw new TurnDeleteError("TURN_NOT_CLOSED", `turn ${String(turn)} is not closed`);
	const originSeqs = new Set(events.filter((event) => !isSystemPromptEvent(event) && isAppendSurfaceEvent(event) && originBelongsToTurn(event, turn, bracket)).map((event) => event.seq));
	const currentNodes = session.surface.nodes;
	if (!currentNodes.includes(target.seq)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is no longer independently deletable`);
	const memo = /* @__PURE__ */ new Map();
	const selected = [];
	const covered = /* @__PURE__ */ new Set();
	for (const seq of currentNodes) {
		const origins = surfaceOrigins(seq, events, memo);
		const targetOrigins = [...origins].filter((origin) => originSeqs.has(origin));
		if (targetOrigins.length === 0) continue;
		if ([...origins].some((origin) => !originSeqs.has(origin))) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} shares a compacted surface node`);
		const current = events[seq];
		if (current !== void 0 && !originSeqs.has(seq) && !(current.type === "tool/result" && current.data.turn === turn)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} contains a non-local replacement`);
		selected.push(seq);
		for (const origin of targetOrigins) covered.add(origin);
	}
	if ([...originSeqs].some((origin) => !covered.has(origin)) || selected.length === 0) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is partially compacted`);
	const positions = selected.map((seq) => currentNodes.indexOf(seq));
	const first = positions[0];
	if (first === void 0 || positions.some((position, index) => position !== first + index)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is not a contiguous surface span`);
	const firstSeq = selected[0];
	const lastSeq = selected.at(-1);
	if (firstSeq === void 0 || lastSeq === void 0) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} has no deletable surface span`);
	signal.throwIfAborted();
	const tombstone = session.append("system/message", {
		turn,
		step: target.data.step,
		message: createTombstoneMessage(session)
	}, {
		surfaceOp: {
			op: "replace",
			startSeq: firstSeq,
			endSeq: lastSeq
		},
		sourceEventSeqs: selected
	});
	await ctx.sessions.flush(session);
	return {
		turn,
		seq: tombstone.seq
	};
}
/**
* Whether the session still has a turn that has not ended yet.
*
* Used to tell "the agent is really working" apart from "the agent status is
* stuck outside `idle` while the durable events show the turn already closed".
*/
function hasOpenTurn(session) {
	const open = /* @__PURE__ */ new Set();
	for (const event of sessionEvents(session)) if (event.type === "turn/start") open.add(event.data.turn);
	else if (event.type === "turn/end") open.delete(event.data.turn);
	return open.size > 0;
}
const BUSY_PHASE_RE = /already has active work/i;
/**
* Run one maintenance job, tolerating a status that has not returned to idle yet.
*
* `agent.runMaintenance` rejects synchronously while the agent phase is anything
* but `idle` (`agent "<id>" already has active work`), which can outlive the turn
* the UI already shows as finished. Wait briefly for idle and retry once; a
* genuinely stuck phase is handled by the caller's fallback.
*
* Failures raised *inside* the job are never retried: only the maintenance claim
* itself can report a busy phase.
*/
async function runMaintenanceIdleAware(agent, job) {
	let insideJob = false;
	const wrapped = (signal) => {
		insideJob = true;
		return job(signal);
	};
	try {
		return await agent.runMaintenance(wrapped);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (insideJob || !BUSY_PHASE_RE.test(message)) throw error;
		await Promise.race([Promise.resolve().then(() => agent.whenIdle()).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4e3))]);
		return await agent.runMaintenance(wrapped);
	}
}
async function deleteTurn(ctx, agent, assistantMessageId) {
	try {
		try {
			return await runMaintenanceIdleAware(agent, (signal) => deleteUnderMaintenance(ctx, agent, assistantMessageId, signal));
		} catch (error) {
			if (error instanceof TurnDeleteError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (!BUSY_PHASE_RE.test(message)) throw error;
			if (hasOpenTurn(agent.session)) throw new TurnDeleteError("AGENT_BUSY", message);
			ctx.logger?.warn?.(`turn-delete: agent "${agent.id}" status is ${agent.status} but no turn is open; deleting directly`);
		}
		return await deleteUnderMaintenance(ctx, agent, assistantMessageId, new AbortController().signal);
	} catch (error) {
		if (error instanceof TurnDeleteError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		ctx.logger?.error?.(`turn-delete: deleting a turn from session "${agent.session.id}" failed: ${message}`);
		throw new TurnDeleteError("DELETE_FAILED", message);
	}
}

//#endregion
//#region src/http.ts
const MAX_BODY_BYTES = 16 * 1024;
function decodeRequest(value) {
	if (typeof value !== "object" || value === null) throw new TypeError("request body must be an object");
	const record = value;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
	if (typeof record.assistantMessageId !== "string" || record.assistantMessageId.length === 0) throw new TypeError("assistantMessageId must be a non-empty string");
	return {
		sessionId: record.sessionId,
		assistantMessageId: record.assistantMessageId
	};
}
function requestJson(request) {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		let settled = false;
		request.on("data", (chunk) => {
			if (settled) return;
			bytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).length : chunk.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				settled = true;
				reject(/* @__PURE__ */ new TypeError("request body is too large"));
				return;
			}
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		});
		request.on("end", () => {
			if (settled) return;
			settled = true;
			try {
				text += decoder.decode();
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}
function respondJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
async function handleTurnDelete(ctx, request, response) {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	const contentType = request.headers?.["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
		respondJson(response, 415, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: "application/json required"
			}
		});
		return;
	}
	try {
		const input = decodeRequest(await requestJson(request));
		const sessionId = SessionId(input.sessionId);
		const agent = ctx.agents.get(sessionId);
		if (agent === void 0) throw new TurnDeleteError("TARGET_NOT_FOUND", `session "${input.sessionId}" is not active`);
		respondJson(response, 200, {
			ok: true,
			value: await deleteTurn(ctx, agent, MessageId(input.assistantMessageId))
		});
	} catch (error) {
		if (error instanceof TurnDeleteError) {
			respondJson(response, error.code === "AGENT_BUSY" ? 423 : error.code === "DELETE_FAILED" ? 500 : 409, {
				ok: false,
				error: {
					code: error.code,
					message: error.message
				}
			});
			return;
		}
		respondJson(response, 400, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: error instanceof Error ? error.message : String(error)
			}
		});
	}
}

//#endregion
//#region src/index.ts
const name = "turn-delete";
const inject = [
	"sessions",
	"agents",
	"webServer"
];
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: TURN_DELETE_PATH,
		handler: (request, response) => handleTurnDelete(ctx, request, response)
	}), "turn-delete: HTTP route");
}

//#endregion
export { TOMBSTONE_MODEL, TOMBSTONE_PROVIDER, TURN_DELETE_PATH, TurnDeleteError, apply, deleteTurn, inject, isTurnDeleteEvent, name, tombstoneSource };