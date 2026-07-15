import { z } from "zod";
export { z };

const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
const GroupPolicySchema = z.enum(["disabled", "allowlist", "open"]);
const ProcessingIndicatorSchema = z.enum(["activity", "off"]);

export const TelexToolsConfigSchema = z
	.object({
		searchIdentities: z.boolean().optional().default(true),
		getIdentities: z.boolean().optional().default(true),
		listConversations: z.boolean().optional().default(true),
		getConversationInfo: z.boolean().optional().default(true),
		createChannel: z.boolean().optional().default(true),
		listMembers: z.boolean().optional().default(true),
		addMembers: z.boolean().optional().default(true),
		getConversationMessages: z.boolean().optional().default(true),
	})
	.strict();

export const TelexAccountConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		apiKey: z.string().optional(),
		baseUrl: z.string().optional(),
		botId: z.string().optional(),
		dmPolicy: DmPolicySchema.optional(),
		allowFrom: z.array(z.string()).optional(),
		groupPolicy: GroupPolicySchema.optional(),
		groupAllowFrom: z.array(z.string()).optional(),
		groupSenderAllowFrom: z.array(z.string()).optional(),
		groupRequireMention: z.boolean().optional(),
		processingIndicator: ProcessingIndicatorSchema.optional(),
	})
	.strict();

export const TelexConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		apiKey: z.string().optional(),
		baseUrl: z.string().optional().default("https://voyager.ingarena.net"),
		botId: z.string().optional(),
		dmPolicy: DmPolicySchema.optional().default("allowlist"),
		allowFrom: z.array(z.string()).optional(),
		groupPolicy: GroupPolicySchema.optional().default("disabled"),
		groupAllowFrom: z.array(z.string()).optional(),
		groupSenderAllowFrom: z.array(z.string()).optional(),
		groupRequireMention: z.boolean().optional().default(true),
		processingIndicator: ProcessingIndicatorSchema.optional().default("activity"),
		tools: TelexToolsConfigSchema.optional(),
		accounts: z.record(z.string(), TelexAccountConfigSchema.optional()).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.dmPolicy === "open") {
			const allowFrom = value.allowFrom ?? [];
			const hasWildcard = allowFrom.some((entry) => entry.trim() === "*");
			if (!hasWildcard) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["allowFrom"],
					message:
						'channels.telex.dmPolicy="open" requires channels.telex.allowFrom to include "*"',
				});
			}
		}
	});
