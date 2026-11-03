import type { ReactNode } from "react";
import { AccountSettingsNav } from "@/components/accounts/account-settings-nav";

export default function AccountSettingsLayout({
	children,
	accountId,
}: {
	children: ReactNode;
	accountId: string;
}) {
	return (
		<div className="flex min-h-[calc(100dvh-5rem)] flex-col gap-8 max-md:pb-20 md:flex-row">
			<div className="min-w-0 flex-1">{children}</div>
			<AccountSettingsNav accountId={accountId} />
		</div>
	);
}
