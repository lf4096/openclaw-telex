import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { type TelexNotice, TelexNoticeLevel, labelMap } from "./types.js";

const noticeLevelLabel = labelMap(TelexNoticeLevel);

type ReplyNoticeRow = {
	flag: "isError" | "isCompactionNotice" | "isFallbackNotice" | "isStatusNotice";
	kind: string;
	level: number;
	fixedTitle?: string;
	skipTool?: boolean;
};

// The first row whose flag a payload carries wins: a payload marked both an error and a status
// notice reports a request that failed, and compaction and fallback notices are status notices
// of a known kind.
const replyNoticeRows: ReplyNoticeRow[] = [
	// A tool summary marked as an error reports one failed call and stays text.
	{
		flag: "isError",
		kind: "task_failed",
		level: TelexNoticeLevel.ERROR,
		fixedTitle: "Task failed",
		skipTool: true,
	},
	{ flag: "isCompactionNotice", kind: "compaction", level: TelexNoticeLevel.INFO },
	{ flag: "isFallbackNotice", kind: "model_fallback", level: TelexNoticeLevel.INFO },
	{ flag: "isStatusNotice", kind: "status", level: TelexNoticeLevel.INFO },
];

function oneLine(value: string): string {
	return value.replace(/\r\n|\n|\r/g, " ");
}

export function noticeLine(notice: TelexNotice): string {
	const kind = oneLine(notice.kind).replace(/["<>]/g, "");
	const level = noticeLevelLabel[notice.level ?? TelexNoticeLevel.INFO] ?? "info";
	const description = oneLine(notice.description ?? "");
	let title = oneLine(notice.title);
	if (description && title.endsWith(".")) title = title.slice(0, -1);
	const body = description ? `${title}. ${description}` : title;
	return `<notice kind="${kind}" level="${level}">${body}</notice>`;
}

// replyNotice is the notice a reply goes out as when the host marks it as its own words. Without
// a fixed title the host's text is the title, so a marked reply stays a reply unless its text is
// one line.
export function replyNotice(
	payload: ReplyPayload,
	text: string,
	dispatchKind: string,
): TelexNotice | undefined {
	const row = replyNoticeRows.find(
		(row) => payload[row.flag] === true && !(row.skipTool && dispatchKind === "tool"),
	);
	if (!row) return undefined;
	const { kind, level, fixedTitle } = row;
	if (!fixedTitle) return text && !/[\r\n]/.test(text) ? { kind, title: text, level } : undefined;
	return { kind, title: fixedTitle, level, ...(text ? { description: text } : {}) };
}
