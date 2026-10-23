import { shortcutSettingsFn, updateShortcutSettingsFn } from "../../functions";
export async function loadShortcutsEnabled() {
	return (await shortcutSettingsFn()).enabled;
}
export async function updateShortcutsEnabled(enabled: boolean) {
	return (await updateShortcutSettingsFn({ data: { enabled } })).enabled;
}
