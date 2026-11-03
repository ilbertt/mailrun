declare module "parse-srcset" {
	export interface Candidate {
		url: string;
		w?: number;
		h?: number;
		d?: number;
	}
	export default function parseSrcset(input: string): Candidate[];
}
