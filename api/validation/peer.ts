import * as z from 'zod';

/** The most files one batch can hold. */
export const MAX_BATCH_FILES = 500;

const transferBatchSchema = z
	.object({
		id: z.uuid(),
		index: z.number().int().min(0),
		count: z.number().int().min(2).max(MAX_BATCH_FILES),
		size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		tracks: z
			.array(
				z.object({
					title: z.string().max(200),
					artist: z.string().max(200)
				})
			)
			.max(MAX_BATCH_FILES)
			.optional()
	})
	.refine((batch) => batch.index < batch.count, { message: 'Batch index out of range.' })
	.refine((batch) => !batch.tracks || batch.tracks.length === batch.count, {
		message: 'Batch track list does not match its count.'
	});

// checks if the sent data meets our requirements
export const transferRequestSchema = z
	.object({
		targetDeviceId: z.string().min(1).max(128),
		file: z.object({
			name: z.string().trim().min(1).max(255),
			size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			type: z.string().max(255)
		}),
		batch: transferBatchSchema.optional()
	})
	.refine((request) => !request.batch || request.batch.size >= request.file.size, {
		message: 'Batch size is smaller than the file.'
	});

export const deviceRegistrationSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(1).max(40)
});

export const transferDecisionSchema = z.object({
	transferId: z.uuid(),
	accepted: z.boolean()
});

export const transferCancelSchema = z.object({
	transferId: z.uuid()
});

export const transferReadySchema = z.object({
	transferId: z.uuid(),
	peerId: z
		.string()
		.max(128)
		.regex(/^[a-zA-Z0-9]+(?:[ _-][a-zA-Z0-9]+)*$/)
});

export const transferFinishSchema = z.object({
	transferId: z.uuid(),
	outcome: z.enum(['completed', 'failed'])
});
