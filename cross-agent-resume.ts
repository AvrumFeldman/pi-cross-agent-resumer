import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

type PiSessionItem = {
	type: "pi";
	label: string;
	path: string;
	modifiedMs: number;
};

type ClaudeSessionItem = {
	type: "claude";
	label: string;
	path: string;
	cwd: string;
	title?: string;
	firstMessage: string;
	messageCount: number;
	modifiedMs: number;
	sessionId?: string;
};

type ResumeItem = PiSessionItem | ClaudeSessionItem;

type ImportCache = Record<
	string,
	{
		mtimeMs: number;
		size: number;
		piSessionPath: string;
		importedAt: string;
	}
>;

const EXT_NAME = "cross-agent-resume";
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", EXT_NAME);
const CACHE_FILE = path.join(CACHE_DIR, "claude-imports.json");

function readJsonl(file: string): any[] {
	const text = readFileSync(file, "utf8");
	const rows: any[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed));
		} catch {
			// Ignore malformed rows instead of failing the entire import.
		}
	}
	return rows;
}

function loadCache(): ImportCache {
	try {
		return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveCache(cache: ImportCache): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

function walkJsonlFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkJsonlFiles(p, out);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			out.push(p);
		}
	}
	return out;
}

function shortenHome(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function ageLabel(ms: number): string {
	const diff = Math.max(0, Date.now() - ms);
	const min = Math.floor(diff / 60000);
	const hr = Math.floor(diff / 3600000);
	const day = Math.floor(diff / 86400000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	if (hr < 24) return `${hr}h`;
	if (day < 7) return `${day}d`;
	if (day < 30) return `${Math.floor(day / 7)}w`;
	if (day < 365) return `${Math.floor(day / 30)}mo`;
	return `${Math.floor(day / 365)}y`;
}

function contentToPlainText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text") return block.text ?? "";
			if (block.type === "tool_result") {
				const value = block.content;
				return typeof value === "string" ? value : JSON.stringify(value ?? "");
			}
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function cleanTitle(text: string, max = 90): string {
	const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function claudeProjectsDir(): string {
	return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

function discoverClaudeSessions(): ClaudeSessionItem[] {
	const files = walkJsonlFiles(claudeProjectsDir());
	const result: ClaudeSessionItem[] = [];
	for (const file of files) {
		let stat;
		try {
			stat = statSync(file);
		} catch {
			continue;
		}
		const rows = readJsonl(file);
		let cwd = "";
		let title: string | undefined;
		let firstMessage = "";
		let sessionId: string | undefined;
		let messageCount = 0;

		for (const row of rows) {
			if (!sessionId && typeof row.sessionId === "string") sessionId = row.sessionId;
			if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
			if (!title && row.type === "ai-title" && typeof row.aiTitle === "string") title = row.aiTitle;
			if ((row.type === "user" || row.type === "assistant") && row.message) {
				messageCount++;
				if (!firstMessage && row.type === "user") {
					firstMessage = cleanTitle(contentToPlainText(row.message.content));
				}
			}
		}
		const display = title || firstMessage || path.basename(file, ".jsonl");
		const cwdPart = cwd ? `  ${shortenHome(cwd)}` : "";
		result.push({
			type: "claude",
			label: `Claude  ${cleanTitle(display, 70)}  ${messageCount} ${ageLabel(stat.mtimeMs)}${cwdPart}`,
			path: file,
			cwd,
			title,
			firstMessage,
			messageCount,
			modifiedMs: stat.mtimeMs,
			sessionId,
		});
	}
	return result.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function piUsage(usage: any) {
	const input = Number(usage?.input_tokens ?? usage?.input ?? 0) || 0;
	const output = Number(usage?.output_tokens ?? usage?.output ?? 0) || 0;
	const cacheRead = Number(usage?.cache_read_input_tokens ?? usage?.cacheRead ?? 0) || 0;
	const cacheWrite = Number(usage?.cache_creation_input_tokens ?? usage?.cacheWrite ?? 0) || 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(reason: any): "stop" | "length" | "toolUse" | "error" | "aborted" {
	if (reason === "tool_use") return "toolUse";
	if (reason === "max_tokens") return "length";
	if (reason === "error") return "error";
	return "stop";
}

function claudeContentToPiBlocks(content: any): any[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
	const blocks: any[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") {
			blocks.push({ type: "text", text: String(block.text ?? "") });
		} else if (block.type === "thinking") {
			const thinking = String(block.thinking ?? "");
			if (thinking.trim()) blocks.push({ type: "thinking", thinking });
		} else if (block.type === "tool_use") {
			blocks.push({
				type: "toolCall",
				id: String(block.id ?? `claude_tool_${crypto.randomBytes(4).toString("hex")}`),
				name: `claude_${String(block.name ?? "tool")}`,
				arguments: block.input ?? {},
			});
		} else if (block.type === "image") {
			// Claude image block shapes vary; keep a placeholder rather than risking invalid Pi image data.
			blocks.push({ type: "text", text: "[Claude image attachment omitted during import]" });
		}
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function appendClaudeRow(sm: SessionManager, row: any): void {
	if (!row || (row.type !== "user" && row.type !== "assistant") || !row.message) return;
	const ts = row.timestamp ? new Date(row.timestamp).getTime() : Date.now();
	const msg = row.message;

	if (row.type === "user") {
		const content = msg.content;
		if (Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "tool_result")) {
			for (const block of content) {
				const value = block.content;
				sm.appendMessage({
					role: "toolResult",
					toolCallId: String(block.tool_use_id ?? `claude_tool_result_${crypto.randomBytes(4).toString("hex")}`),
					toolName: "claude_tool",
					content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? "") }],
					isError: Boolean(block.is_error),
					timestamp: ts,
				} as any);
			}
			return;
		}
		sm.appendMessage({ role: "user", content: claudeContentToPiBlocks(content), timestamp: ts } as any);
		return;
	}

	if (row.type === "assistant") {
		sm.appendMessage({
			role: "assistant",
			content: claudeContentToPiBlocks(msg.content),
			api: "anthropic",
			provider: "anthropic",
			model: String(msg.model ?? "claude"),
			usage: piUsage(msg.usage),
			stopReason: mapStopReason(msg.stop_reason),
			timestamp: ts,
		} as any);
	}
}

function importClaudeSession(item: ClaudeSessionItem, fallbackCwd: string): string {
	const stat = statSync(item.path);
	const cache = loadCache();
	const cached = cache[item.path];
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && existsSync(cached.piSessionPath)) {
		return cached.piSessionPath;
	}

	const rows = readJsonl(item.path);
	const cwd = item.cwd || rows.find((r) => typeof r?.cwd === "string")?.cwd || fallbackCwd;
	const sm = SessionManager.create(cwd);
	const title = item.title || item.firstMessage || `Claude ${item.sessionId ?? path.basename(item.path, ".jsonl")}`;
	sm.appendSessionInfo(`Claude: ${cleanTitle(title, 100)}`);
	sm.appendCustomEntry(EXT_NAME, {
		source: "claude-code",
		sourcePath: item.path,
		sourceSessionId: item.sessionId,
		importedAt: new Date().toISOString(),
	});
	for (const row of rows) appendClaudeRow(sm, row);
	const piSessionPath = sm.getSessionFile();
	if (!piSessionPath) throw new Error("Failed to create Pi session file for imported Claude session");
	cache[item.path] = { mtimeMs: stat.mtimeMs, size: stat.size, piSessionPath, importedAt: new Date().toISOString() };
	saveCache(cache);
	return piSessionPath;
}

async function listPiSessions(cwd: string): Promise<PiSessionItem[]> {
	const sessions = await SessionManager.list(cwd);
	return sessions.map((s) => ({
		type: "pi" as const,
		label: `Pi      ${cleanTitle(s.name || s.firstMessage || s.id, 70)}  ${s.messageCount} ${ageLabel(s.modified.getTime())}`,
		path: s.path,
		modifiedMs: s.modified.getTime(),
	}));
}

function itemPrimaryLabel(item: ResumeItem): string {
	if (item.type === "pi") return cleanTitle(item.label.replace(/^Pi\s+/, "Pi: "), 100);
	return `Claude: ${cleanTitle(item.title || item.firstMessage || path.basename(item.path, ".jsonl"), 92)}`;
}

function itemDescription(item: ResumeItem): string {
	const age = ageLabel(item.modifiedMs);
	if (item.type === "pi") return `${age} • ${shortenHome(item.path)}`;
	const cwd = item.cwd ? ` • ${shortenHome(item.cwd)}` : "";
	return `${item.messageCount} msgs • ${age}${cwd}`;
}

async function chooseResumeItem(ctx: any, items: ResumeItem[]): Promise<ResumeItem | undefined> {
	const selectItems: SelectItem[] = items.map((item, index) => ({
		value: String(index),
		label: itemPrimaryLabel(item),
		description: itemDescription(item),
	}));

	const selectedValue = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Resume session")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new Spacer(1));

		const list = new SelectList(selectItems, 5, {
			selectedPrefix: (s: string) => theme.fg("accent", s),
			selectedText: (s: string) => theme.bg("selectedBg", theme.fg("accent", s)),
			description: (s: string) => theme.fg("muted", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
			noMatch: (s: string) => theme.fg("warning", s),
		}, {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 72,
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (selectedValue === null || selectedValue === undefined) return undefined;
	const index = Number(selectedValue);
	return Number.isFinite(index) ? items[index] : undefined;
}

export default function crossAgentResume(pi: ExtensionAPI) {
	pi.registerCommand("xresume", {
		description: "Resume Pi or Claude Code sessions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/xresume requires interactive mode", "error");
				return;
			}
			await ctx.waitForIdle();

			let items: ResumeItem[] = [];
			try {
				const [piItems, claudeItems] = await Promise.all([listPiSessions(ctx.cwd), Promise.resolve(discoverClaudeSessions())]);
				items = [...piItems, ...claudeItems].sort((a, b) => b.modifiedMs - a.modifiedMs);
			} catch (err) {
				ctx.ui.notify(`Failed to discover sessions: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			if (items.length === 0) {
				ctx.ui.notify("No Pi or Claude Code sessions found", "info");
				return;
			}

			const item = await chooseResumeItem(ctx, items);
			if (!item) return;

			if (item.type === "pi") {
				const result = await ctx.switchSession(item.path, {
					withSession: async (replacementCtx) => replacementCtx.ui.notify("Resumed Pi session", "info"),
				});
				if (result.cancelled) ctx.ui.notify("Resume cancelled", "info");
				return;
			}

			try {
				ctx.ui.notify("Importing Claude Code session...", "info");
				const piSessionPath = importClaudeSession(item, ctx.cwd);
				const result = await ctx.switchSession(piSessionPath, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify(`Imported Claude Code session from ${shortenHome(item.path)}`, "info");
					},
				});
				if (result.cancelled) ctx.ui.notify("Resume cancelled", "info");
			} catch (err) {
				ctx.ui.notify(`Claude import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
