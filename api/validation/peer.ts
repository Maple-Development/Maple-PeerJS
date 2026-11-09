import * as z from 'zod';

// checks if the sent data is valid
export const transferRequestSchema = z.object({
	targetDeviceId: z.string().min(1).max(128),
	file: z.object({
		name: z.string().trim().min(1).max(255),
		size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		type: z.string().max(255)
	})
});

// verify it's a valid device scheme
export const deviceRegistrationSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(1).max(40)
});