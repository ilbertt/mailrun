import { useState } from "react";
import {
	useMutation,
	useQuery,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Forward, Mail, ShieldBan } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "./ui/dialog";
import { useMail } from "./mail-context";
import { mailSettingsQuery } from "../queries";
import {
	addAliasFn,
	removeAliasFn,
	domainAliasesFn,
	forwardingFn,
	saveRuleFn,
	removeRuleFn,
	setupStatusFn,
	refreshRelayFn,
} from "../functions";
import { ruleSchema } from "../shared/mail-contracts";
import type { z } from "zod";
export function RelayUpdate() {
	const { user } = useMail();
	const client = useQueryClient();
	const status = useQuery({
		queryKey: ["email-setup", user.id],
		queryFn: () => setupStatusFn(),
		enabled: user.isPrimaryAdmin,
		staleTime: 60000,
	});
	const update = useMutation({
		mutationFn: () => refreshRelayFn(),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["email-setup", user.id] }),
	});
	if (!status.data?.needsRelayUpdate) return null;
	return (
		<div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
			<p>
				Update your Cloudflare email relay to enable the latest forwarding
				behavior.
			</p>
			<Button
				size="sm"
				className="mt-3"
				disabled={update.isPending}
				onClick={() => update.mutate()}
			>
				{update.isPending ? "Updating…" : "Update email relay"}
			</Button>
			{update.error && (
				<p role="alert" className="mt-2 text-red-600">
					{update.error.message}
				</p>
			)}
		</div>
	);
}

export function MailboxSettings() {
	const { user, mailboxes } = useMail();
	const client = useQueryClient();
	const { data } = useSuspenseQuery(mailSettingsQuery(user.id));
	const [adding, setAdding] = useState<string | null>(null);
	const refresh = async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["mail-settings", user.id] }),
			client.invalidateQueries({ queryKey: ["mailboxes", user.id] }),
		]);
	};
	const add = useMutation({
		mutationFn: addAliasFn,
		onSuccess: async () => {
			setAdding(null);
			await refresh();
		},
	});
	const remove = useMutation({ mutationFn: removeAliasFn, onSuccess: refresh });
	const toggle = useMutation({
		mutationFn: domainAliasesFn,
		onSuccess: refresh,
	});
	return (
		<div className="max-w-4xl">
			<h1 className="text-2xl font-semibold">Mailboxes</h1>
			<p className="mt-2 text-sm text-neutral-500">
				Manage your mailbox addresses and aliases.
			</p>
			{(remove.error || toggle.error) && (
				<p role="alert" className="mt-4 text-sm text-red-600">
					{remove.error?.message ?? toggle.error?.message}
				</p>
			)}
			<div className="mt-6 space-y-4">
				{mailboxes.map((mailbox) => (
					<div
						className="rounded-xl border border-neutral-200 bg-white p-5"
						key={mailbox.id}
					>
						<div className="flex items-center justify-between gap-4">
							<div>
								<h2 className="font-medium">
									{mailbox.display_name || mailbox.local_part}
								</h2>
								<p className="mt-1 text-sm text-neutral-500">
									{mailbox.local_part}@{mailbox.hostname}
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={mailbox.permission !== "full_access"}
								onClick={() => setAdding(mailbox.id)}
							>
								<Plus size={14} />
								Add alias
							</Button>
						</div>
						<label className="mt-5 flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={!!mailbox.use_all_domains}
								disabled={
									toggle.isPending || mailbox.permission !== "full_access"
								}
								onChange={(event) =>
									toggle.mutate({
										data: {
											mailboxId: mailbox.id,
											enabled: event.target.checked,
										},
									})
								}
							/>
							Use this mailbox address across all my domains
						</label>
						<div className="mt-4 flex flex-wrap gap-2">
							{data.aliases
								.filter((alias) => alias.mailbox_id === mailbox.id)
								.map((alias) => (
									<span
										key={alias.id}
										className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs"
									>
										{alias.local_part}@{alias.hostname}
										<button
											aria-label={`Remove alias ${alias.local_part}`}
											disabled={
												remove.isPending || mailbox.permission !== "full_access"
											}
											onClick={() => remove.mutate({ data: { id: alias.id } })}
										>
											<Trash2 size={12} />
										</button>
									</span>
								))}
						</div>
					</div>
				))}
			</div>
			<Dialog
				open={!!adding}
				onOpenChange={(open) => {
					if (!open) setAdding(null);
				}}
			>
				<DialogContent className="max-h-[90dvh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Add mailbox alias</DialogTitle>
						<DialogDescription>
							Mail sent to this address is delivered to the same mailbox.
						</DialogDescription>
					</DialogHeader>
					<form
						className="mt-3 space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							if (adding)
								add.mutate({
									data: {
										mailboxId: adding,
										domainId: String(form.get("domainId")),
										localPart: String(form.get("localPart")),
									},
								});
						}}
					>
						<div className="grid grid-cols-2 gap-3">
							<label className="space-y-2 text-sm">
								Address
								<Input name="localPart" placeholder="alias" required />
							</label>
							<label className="space-y-2 text-sm">
								Domain
								<select
									name="domainId"
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									defaultValue={
										mailboxes.find((mailbox) => mailbox.id === adding)
											?.domain_id
									}
								>
									{data.domains
										.filter((domain) => domain.user_id === user.id)
										.map((domain) => (
											<option key={domain.id} value={domain.id}>
												@{domain.hostname}
											</option>
										))}
								</select>
							</label>
						</div>
						{add.error && (
							<p role="alert" className="text-sm text-red-600">
								{add.error.message}
							</p>
						)}
						<Button type="submit" disabled={add.isPending}>
							{add.isPending ? "Adding…" : "Add alias"}
						</Button>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
export function ForwardingSettings() {
	const { user } = useMail();
	const client = useQueryClient();
	const { data } = useSuspenseQuery(mailSettingsQuery(user.id));
	const mutation = useMutation({
		mutationFn: forwardingFn,
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["mail-settings", user.id] }),
	});
	return (
		<div className="max-w-2xl">
			<h1 className="text-2xl font-semibold">Forwarding</h1>
			<p className="mt-2 text-sm text-neutral-500">
				Automatically forward incoming email and keep a copy in your mailbox.
			</p>
			<form
				className="mt-6 space-y-5 rounded-xl border border-neutral-200 p-6"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate({
						data: {
							email: String(
								new FormData(event.currentTarget).get("email") ?? "",
							),
						},
					});
				}}
			>
				<label className="block space-y-2 text-sm">
					<span>Forward to</span>
					<Input
						name="email"
						type="email"
						placeholder="name@example.com"
						defaultValue={data.forwardingEmail}
					/>
				</label>
				<p className="text-xs text-neutral-500">
					Use a verified destination address in Cloudflare Email Routing. Leave
					blank to turn forwarding off.
				</p>
				{mutation.error && (
					<p role="alert" className="text-sm text-red-600">
						{mutation.error.message}
					</p>
				)}
				{mutation.isSuccess && (
					<p role="status" className="text-sm text-green-700">
						Forwarding settings saved.
					</p>
				)}
				<Button type="submit" disabled={mutation.isPending}>
					Save changes
				</Button>
			</form>
		</div>
	);
}
export function RoutingSettings() {
	const { user, mailboxes } = useMail();
	const client = useQueryClient();
	const { data } = useSuspenseQuery(mailSettingsQuery(user.id));
	const [editing, setEditing] = useState<z.infer<typeof ruleSchema> | null>(
		null,
	);
	const fresh = (): z.infer<typeof ruleSchema> => ({
		domainId: data.domains[0]?.id ?? "",
		scope: "domain",
		name: "",
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: "*",
		action: "store",
		mailboxId: mailboxes[0]?.id,
		keepCopy: false,
		forwardTo: "",
		rejectReason: "",
		priority: 0,
	});
	const refresh = () =>
		client.invalidateQueries({ queryKey: ["mail-settings", user.id] });
	const save = useMutation({
		mutationFn: saveRuleFn,
		onSuccess: async () => {
			setEditing(null);
			await refresh();
		},
	});
	const remove = useMutation({ mutationFn: removeRuleFn, onSuccess: refresh });
	return (
		<div className="max-w-5xl">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Routing rules</h1>
					<p className="mt-2 text-sm text-neutral-500">
						Route, forward, reject, or organize incoming mail.
					</p>
				</div>
				<Button size="sm" onClick={() => setEditing(fresh())}>
					<Plus size={14} />
					New rule
				</Button>
			</div>
			{remove.error && (
				<p role="alert" className="mt-3 text-sm text-red-600">
					{remove.error.message}
				</p>
			)}
			<div className="mt-6 overflow-hidden rounded-xl border border-neutral-200">
				<table className="w-full text-left text-sm">
					<thead className="bg-neutral-50 text-xs text-neutral-500">
						<tr>
							<th className="p-4">Rule</th>
							<th>Condition</th>
							<th>Action</th>
							<th>Priority</th>
							<th className="p-4 text-right">Actions</th>
						</tr>
					</thead>
					<tbody>
						{data.rules.map((rule) => (
							<tr className="border-t border-neutral-100" key={rule.id}>
								<td className="p-4">
									<div className="font-medium">{rule.name || rule.pattern}</div>
									<div className="mt-1 text-xs text-neutral-500">
										{
											data.domains.find(
												(domain) => domain.id === rule.domain_id,
											)?.hostname
										}{" "}
										· {rule.scope}
										{!rule.enabled ? " · Disabled" : ""}
									</div>
								</td>
								<td>
									{rule.match_field} {rule.match_operator.replaceAll("_", " ")}{" "}
									<span className="font-mono text-xs">
										{rule.match_value || rule.pattern}
									</span>
								</td>
								<td>
									<span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">
										{rule.action === "forward" ? (
											<Forward size={12} />
										) : rule.action === "reject" ? (
											<ShieldBan size={12} />
										) : (
											<Mail size={12} />
										)}{" "}
										{rule.action}
									</span>
									{rule.keep_copy ? " + copy" : ""}
								</td>
								<td>{rule.priority}</td>
								<td className="space-x-3 p-4 text-right">
									<button
										aria-label={`Edit rule ${rule.name || rule.pattern}`}
										onClick={() =>
											setEditing(
												ruleSchema.parse({
													id: rule.id,
													domainId: rule.domain_id,
													scope: rule.scope,
													name: rule.name ?? "",
													enabled: !!rule.enabled,
													matchField: rule.match_field,
													matchOperator: rule.match_operator,
													matchValue: rule.match_value || rule.pattern,
													action: rule.action,
													mailboxId: rule.mailbox_id,
													folderId: rule.folder_id,
													forwardTo: rule.forward_to ?? "",
													keepCopy: !!rule.keep_copy,
													rejectReason: rule.reject_reason ?? "",
													priority: rule.priority,
												}),
											)
										}
									>
										<Pencil size={15} />
									</button>
									<button
										aria-label="Delete rule"
										disabled={remove.isPending}
										onClick={() => remove.mutate({ data: { id: rule.id } })}
									>
										<Trash2 size={15} />
									</button>
								</td>
							</tr>
						))}
						{!data.rules.length && (
							<tr>
								<td colSpan={5} className="p-12 text-center text-neutral-500">
									No routing rules yet.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<Dialog
				open={!!editing}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
			>
				<DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							{editing?.id ? "Edit rule" : "New routing rule"}
						</DialogTitle>
						<DialogDescription>
							Reject rules run before delivery. Real addresses take precedence
							over catch-all rules.
						</DialogDescription>
					</DialogHeader>
					{editing && (
						<form
							className="mt-3 grid grid-cols-2 gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								save.mutate({ data: editing });
							}}
						>
							<label className="col-span-2 space-y-1 text-sm">
								Name
								<Input
									value={editing.name}
									onChange={(event) =>
										setEditing({ ...editing, name: event.target.value })
									}
								/>
							</label>
							<label className="space-y-1 text-sm">
								Scope
								<select
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									value={editing.scope}
									onChange={(event) =>
										setEditing({
											...editing,
											scope:
												event.target.value === "domain" ? "domain" : "mailbox",
											action:
												event.target.value === "domain" ? "store" : "spam",
											matchField: "recipient",
										})
									}
								>
									<option value="domain">Domain routing</option>
									<option value="mailbox">Inbox rule</option>
								</select>
							</label>
							<label className="space-y-1 text-sm">
								Domain
								<select
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									value={editing.domainId}
									onChange={(event) =>
										setEditing({
											...editing,
											domainId: event.target.value,
											mailboxId: mailboxes.find(
												(mailbox) => mailbox.domain_id === event.target.value,
											)?.id,
										})
									}
								>
									{data.domains.map((domain) => (
										<option key={domain.id} value={domain.id}>
											{domain.hostname}
										</option>
									))}
								</select>
							</label>
							<label className="space-y-1 text-sm">
								Match field
								<select
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									value={editing.matchField}
									onChange={(event) =>
										setEditing({
											...editing,
											matchField: ruleSchema.shape.matchField.parse(
												event.target.value,
											),
										})
									}
								>
									{["recipient", "sender", "title", "content", "email"].map(
										(field) => (
											<option key={field}>{field}</option>
										),
									)}
								</select>
							</label>
							<label className="space-y-1 text-sm">
								Condition
								<select
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									value={editing.matchOperator}
									onChange={(event) =>
										setEditing({
											...editing,
											matchOperator: ruleSchema.shape.matchOperator.parse(
												event.target.value,
											),
										})
									}
								>
									{[
										"contains",
										"exact",
										"starts_with",
										"ends_with",
										"regex",
									].map((condition) => (
										<option value={condition} key={condition}>
											{condition.replaceAll("_", " ")}
										</option>
									))}
								</select>
							</label>
							<label className="col-span-2 space-y-1 text-sm">
								Value
								<Input
									value={editing.matchValue}
									onChange={(event) =>
										setEditing({ ...editing, matchValue: event.target.value })
									}
									placeholder="* for all email"
									required
								/>
							</label>
							<label className="space-y-1 text-sm">
								Action
								<select
									className="h-10 w-full rounded-lg border border-neutral-200 px-3"
									value={editing.action}
									onChange={(event) =>
										setEditing({
											...editing,
											action: ruleSchema.shape.action.parse(event.target.value),
										})
									}
								>
									{(editing.scope === "domain"
										? ["store", "forward", "reject"]
										: ["store", "spam", "trash"]
									).map((action) => (
										<option key={action}>{action}</option>
									))}
								</select>
							</label>
							<label className="space-y-1 text-sm">
								Priority
								<Input
									type="number"
									value={editing.priority}
									onChange={(event) =>
										setEditing({
											...editing,
											priority: Number(event.target.value),
										})
									}
								/>
							</label>
							{editing.action !== "reject" && (
								<label className="col-span-2 space-y-1 text-sm">
									Destination mailbox
									<select
										className="h-10 w-full rounded-lg border border-neutral-200 px-3"
										value={editing.mailboxId ?? ""}
										onChange={(event) =>
											setEditing({
												...editing,
												mailboxId: event.target.value || null,
											})
										}
									>
										<option value="">None</option>
										{mailboxes
											.filter(
												(mailbox) => mailbox.domain_id === editing.domainId,
											)
											.map((mailbox) => (
												<option value={mailbox.id} key={mailbox.id}>
													{mailbox.local_part}@{mailbox.hostname}
												</option>
											))}
									</select>
								</label>
							)}
							{editing.scope === "mailbox" && editing.action === "store" && (
								<label className="col-span-2 space-y-1 text-sm">
									Destination folder
									<select
										required
										className="h-10 w-full rounded-lg border border-neutral-200 px-3"
										value={editing.folderId ?? ""}
										onChange={(event) =>
											setEditing({
												...editing,
												folderId: event.target.value || null,
											})
										}
									>
										<option value="">Select a folder</option>
										{data.folders
											.filter(
												(folder) => folder.mailbox_id === editing.mailboxId,
											)
											.map((folder) => (
												<option key={folder.id} value={folder.id ?? ""}>
													{folder.name}
												</option>
											))}
									</select>
								</label>
							)}
							{editing.action === "forward" && (
								<>
									<label className="col-span-2 space-y-1 text-sm">
										Forward to
										<Input
											type="email"
											value={editing.forwardTo}
											onChange={(event) =>
												setEditing({
													...editing,
													forwardTo: event.target.value,
												})
											}
											required
										/>
									</label>
									<label className="col-span-2 flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={editing.keepCopy}
											onChange={(event) =>
												setEditing({
													...editing,
													keepCopy: event.target.checked,
												})
											}
										/>
										Keep a copy in the destination mailbox
									</label>
								</>
							)}
							{editing.action === "reject" && (
								<label className="col-span-2 space-y-1 text-sm">
									Reject reason
									<Input
										value={editing.rejectReason}
										onChange={(event) =>
											setEditing({
												...editing,
												rejectReason: event.target.value,
											})
										}
									/>
								</label>
							)}
							<label className="col-span-2 flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={editing.enabled}
									onChange={(event) =>
										setEditing({ ...editing, enabled: event.target.checked })
									}
								/>
								Enabled
							</label>
							{save.error && (
								<p role="alert" className="col-span-2 text-sm text-red-600">
									{save.error.message}
								</p>
							)}
							<div className="col-span-2">
								<Button type="submit" disabled={save.isPending}>
									Save rule
								</Button>
							</div>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
