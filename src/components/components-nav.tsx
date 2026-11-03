import { MailLink as Link } from "./mail-link";
import type { DragEvent } from "react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { usePathname } from "@/lib/navigation";
import { getMessageDragData } from "@/lib/messages/drag-utils";
import { useSidebar } from "./sidebar-state";
import { useCompose } from "./compose/compose-context";
import { Tooltip } from "./ui/tooltip";
import type { NavLink } from "./components-nav-types";

type Props = {
	link: NavLink;
	iconClassName?: string;
	labelClassName?: string;
	wrap?: boolean;
};
export function NavItem({ link, iconClassName, labelClassName, wrap }: Props) {
	const pathname = usePathname();
	const { openComposer } = useCompose();
	const { minimal } = useSidebar();
	const [dragOver, setDragOver] = useState(false);

	if (!link.href) {
		return <span className="flex-1" />;
	}

	const Icon = link.icon;
	if (!Icon) return null;
	const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
	const classes = cn(
		"flex h-9 items-center gap-3 rounded-r-full text-sm text-neutral-700 transition-colors max-md:min-h-11 max-md:text-base",
		minimal && "relative mx-auto w-10 justify-center rounded-full px-0",
		active
			? "bg-blue-100 text-blue-900 font-semibold"
			: "hover:bg-neutral-200/60",
		dragOver && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
		link.primary &&
			"mb-3 h-12 w-fit rounded-2xl bg-blue-100 px-5 text-blue-950 shadow-sm hover:bg-blue-200",
		link.count && "font-semibold",
		link.primary && minimal && "h-11 w-11 rounded-2xl px-0",
		wrap && !minimal && "h-auto min-h-9 items-start py-2",
	);
	const dropProps = link.onMessageDrop
		? {
				onDragOver: (event: DragEvent) => {
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					setDragOver(true);
				},
				onDragLeave: () => setDragOver(false),
				onDrop: (event: DragEvent) => {
					const payload = getMessageDragData(event.dataTransfer);
					setDragOver(false);
					if (!payload) return;
					event.preventDefault();
					link.onMessageDrop?.(payload.messageIds);
				},
			}
		: {};

	if (link.href === "/compose") {
		const composeButton = (
			<button
				type="button"
				onClick={openComposer}
				className={cn(!minimal && "ml-3", classes)}
				aria-label={minimal ? link.label : undefined}
				{...dropProps}
			>
				<Icon
					size={19}
					style={{ color: link.iconColor }}
					className={iconClassName}
				/>
				{!minimal && (
					<span
						className={cn(
							"flex-1",
							typeof link.count === "number" &&
								link.count > 0 &&
								"font-semibold",
						)}
					>
						{link.label}
					</span>
				)}
				{!minimal && typeof link.count === "number" && link.count > 0 && (
					<span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
						{link.count > 99 ? "99+" : link.count}
					</span>
				)}
				{minimal && typeof link.count === "number" && link.count > 0 && (
					<span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
						{link.count > 99 ? "99+" : link.count}
					</span>
				)}
			</button>
		);
		return minimal && link.label ? (
			<Tooltip label={link.label} placement="right" className="mx-auto">
				{composeButton}
			</Tooltip>
		) : (
			composeButton
		);
	}

	const navLink = (
		<Link
			href={link.href}
			aria-label={minimal ? link.label : undefined}
			className={cn(!minimal && "pl-6", classes)}
			{...dropProps}
		>
			<Icon
				// className={minimal ? "h-4 w-4" : "h-5 w-5"}
				style={{ color: link.iconColor }}
				size={16}
				className={cn(
					"max-md:h-5 max-md:w-5",
					wrap && !minimal && "mt-0.5 shrink-0",
					iconClassName,
				)}
			/>
			{!minimal && (
				<span
					className={cn(
						"flex-1",
						wrap && "min-w-0 break-words leading-5 max-md:leading-6",
						labelClassName,
						typeof link.count === "number" && link.count > 0 && "font-semibold",
					)}
				>
					{link.label}
				</span>
			)}
			{!minimal && typeof link.count === "number" && link.count > 0 && (
				<span
					className={cn(
						"ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700",
						wrap && "shrink-0 py-0 leading-5",
					)}
				>
					{link.count > 99 ? "99+" : link.count}
				</span>
			)}
			{minimal && typeof link.count === "number" && link.count > 0 && (
				<span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
					{link.count > 99 ? "99+" : link.count}
				</span>
			)}
		</Link>
	);

	return minimal && link.label ? (
		<Tooltip label={link.label} placement="right" className="mx-auto">
			{navLink}
		</Tooltip>
	) : (
		navLink
	);
}
