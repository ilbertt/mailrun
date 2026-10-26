export type DriveRow = {
	id: string;
	ownerId: string;
	parentId: string | null;
	kind: "file" | "folder";
	name: string;
	r2Key: string | null;
	size: number;
	contentType: string;
	linkToken: string | null;
	trashedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};
export type DriveRole = "owner" | "edit" | "view";
export type DriveShareRole = "view" | "edit";

export type DriveItemDto = {
	id: string;
	kind: "file" | "folder";
	name: string;
	size: number;
	contentType: string;
	parentId: string | null;
	ownerId: string;
	ownerName: string;
	ownerHasAvatar: boolean;
	role: DriveRole;
	shared: boolean;
	linkToken: string | null;
	trashedAt: string | null;
	updatedAt: string;
	/** Set for files that come from an email rather than from Drive. */
	source?: {
		messageId: string;
		subject: string;
		direction: "inbound" | "outbound";
		canDelete: boolean;
	};
};

export type DriveCrumb = { id: string; name: string };

export type DriveShareDto = {
	id: string;
	userId: string;
	name: string;
	email: string;
	role: DriveShareRole;
};
