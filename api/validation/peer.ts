import * as z from 'zod';

// checks if the sent data meets our requirements
export const transferRequestSchema = z.object({
	targetDeviceId: z.string().min(1).max(128),
	file: z.object({
		name: z.string().trim().min(1).max(255),
		size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		type: z.string().max(255)
	})
});

export const deviceRegistrationSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(1).max(40)
});

export const transferDecisionSchema = z.object({
	transferId: z.uuid(),
	accepted: z.boolean()
});
