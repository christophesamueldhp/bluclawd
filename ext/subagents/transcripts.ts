import { readFileSync } from "node:fs";
import {
	type AgentSession,
	buildSessionContext,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ChildSession } from "./runner.ts";

export type TranscriptMessage = AgentSession["messages"][number];

/** A run's transcript: its live child session while a generation runs, its session file otherwise. */
export interface TranscriptSource {
	/** The messages so far, and the assistant message still streaming, if any. */
	read(): { messages: readonly TranscriptMessage[]; streaming?: TranscriptMessage };
	/** Calls `listener` whenever the transcript or its run may have changed; returns a way to stop. */
	watch(listener: () => void): () => void;
}

interface RunTranscript {
	session?: ChildSession;
	streaming?: TranscriptMessage;
	stop?: () => void;
	/** The session file, which every generation of the run appends to; written from the run's first message on. */
	file?: string;
	watchers: Set<() => void>;
}

/** The transcripts of this instance's runs, by run id. */
export function createRunTranscripts() {
	const runs = new Map<string, RunTranscript>();
	const entry = (runId: string) => {
		let run = runs.get(runId);
		if (!run) {
			run = { watchers: new Set() };
			runs.set(runId, run);
		}
		return run;
	};
	const changed = (runId: string) => {
		for (const listener of runs.get(runId)?.watchers ?? []) listener();
	};

	return {
		changed,
		/** A generation's child session was created. */
		attach(runId: string, session: ChildSession) {
			const run = entry(runId);
			run.stop?.();
			run.session = session;
			run.streaming = undefined;
			run.file = session.sessionFile ?? run.file;
			run.stop = session.subscribe((event) => {
				if (event.type === "message_start" || event.type === "message_update") {
					if (event.message.role === "assistant") run.streaming = event.message;
				} else if (event.type === "message_end") run.streaming = undefined;
				changed(runId);
			});
			changed(runId);
		},
		/** A generation's child session is about to be disposed. */
		detach(runId: string) {
			const run = runs.get(runId);
			if (!run?.session) return;
			run.stop?.();
			run.stop = run.session = run.streaming = undefined;
			changed(runId);
		},
		source(runId: string): TranscriptSource {
			return {
				read: () => {
					const run = runs.get(runId);
					if (run?.session) return { messages: run.session.messages, streaming: run.streaming };
					return { messages: run?.file ? readSessionFile(run.file) : [] };
				},
				watch: (listener) => {
					const { watchers } = entry(runId);
					watchers.add(listener);
					return () => watchers.delete(listener);
				},
			};
		},
	};
}

/** A session file's messages; none while the file is not written yet. */
function readSessionFile(path: string): TranscriptMessage[] {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const entries = parseSessionEntries(content).filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(entries).messages;
}
