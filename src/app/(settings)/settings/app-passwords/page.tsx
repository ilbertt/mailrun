import { useLanguage } from "@/components/language-provider";
import { EmailClientsSettings } from "@/components/settings/email-clients-settings";

export default function EmailAppsSettingsPage() {
	const { t } = useLanguage();
	return (
		<div className="space-y-8 py-4">
			<section className="space-y-4">
				<div>
					<h1 className="text-xl font-semibold text-neutral-900">
						{t("settingsPage.appPasswords.title")}
					</h1>
					<p className="mt-1 text-sm text-neutral-500">
						{t("settingsPage.appPasswords.description")}
					</p>
				</div>
				<div className="space-y-4 rounded-3xl bg-white p-6">
					<EmailClientsSettings />
				</div>
			</section>
		</div>
	);
}
