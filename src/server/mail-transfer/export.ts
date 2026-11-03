import type { User } from "../../shared/contracts";
import { withDatabase, withReadSnapshot } from "../db";
import { transferMailbox } from "./repository";
const header = (value: string | null) =>
	(value ?? "").replace(/\r?\n/g, " ").trim();
export async function exportMailbox(
	user: User,
	mailboxId: string,
	head = false,
) {
	const mailbox = await withDatabase((sql) =>
		transferMailbox(sql, user, mailboxId),
	);
	const headers = {
		"Content-Type": "application/mbox; charset=utf-8",
		"Content-Disposition": `attachment; filename="${mailbox.local_part.replace(/["\\\r\n]/g, "_")}.mbox"`,
		"Cache-Control": "no-store",
	};
	if (head) return new Response(null, { headers });
	let finished = Promise.resolve();
	let cancelled = false;
	let release: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			finished = (async () => {
				try {
					await withReadSnapshot(async (sql) => {
						await transferMailbox(sql, user, mailboxId);
						let cursor: { created: number; rowid: number } | undefined;
						while (!cancelled) {
							const rows = cursor
								? await sql.NativeExportMessages`/* @type export_rowid number */
SELECT CAST(rowid AS INTEGER) AS export_rowid,id,from_addr,to_addr,cc_addr,in_reply_to,references_header,subject,provider_message_id,direction,status,created_at,text_body,html_body FROM messages WHERE mailbox_id=${mailboxId} AND (status!='draft' OR user_id=${user.id}) AND (created_at,rowid)>(${cursor.created},${cursor.rowid}) ORDER BY created_at,rowid LIMIT 1`
								: await sql.NativeExportFirstMessage`/* @type export_rowid number */
SELECT CAST(rowid AS INTEGER) AS export_rowid,id,from_addr,to_addr,cc_addr,in_reply_to,references_header,subject,provider_message_id,direction,status,created_at,text_body,html_body FROM messages WHERE mailbox_id=${mailboxId} AND (status!='draft' OR user_id=${user.id}) ORDER BY created_at,rowid LIMIT 1`;
							if (!rows.length) break;
							for (const row of rows) {
								if (cancelled) break;
								const date = new Date(row.created_at * 1000),
									body = row.html_body ?? row.text_body ?? "";
								const text = [
									`From MAILER-DAEMON ${date.toUTCString()}`,
									`Message-ID: ${header(row.provider_message_id || `<${row.id}@mailflare.local>`)}`,
									`Date: ${date.toUTCString()}`,
									`From: ${header(row.from_addr)}`,
									`To: ${header(row.to_addr)}`,
									...(row.cc_addr ? [`Cc: ${header(row.cc_addr)}`] : []),
									...(row.in_reply_to
										? [`In-Reply-To: <${header(row.in_reply_to)}>`]
										: []),
									...(row.references_header
										? [
												`References: ${row.references_header
													.split(/\s+/)
													.filter(Boolean)
													.map((value) => `<${value}>`)
													.join(" ")}`,
											]
										: []),
									`Subject: ${header(row.subject)}`,
									`X-Mailflare-Direction: ${header(row.direction)}`,
									`X-Mailflare-Status: ${header(row.status)}`,
									"MIME-Version: 1.0",
									`Content-Type: ${row.html_body ? "text/html" : "text/plain"}; charset=utf-8`,
									"Content-Transfer-Encoding: 8bit",
									"",
									body.replace(/\nFrom /g, "\n>From "),
									"",
								].join("\r\n");
								controller.enqueue(
									new TextEncoder().encode((cursor ? "\r\n" : "") + text),
								);
								cursor = { created: row.created_at, rowid: row.export_rowid };
								if ((controller.desiredSize ?? 0) <= 0 && !cancelled)
									await new Promise<void>((resolve) => {
										release = resolve;
									});
							}
						}
					});
					if (!cancelled) controller.close();
				} catch (error) {
					if (!cancelled) controller.error(error);
				}
			})();
		},
		pull() {
			release?.();
			release = undefined;
		},
		cancel() {
			cancelled = true;
			release?.();
			release = undefined;
			return finished;
		},
	});
	return new Response(stream, { headers });
}
