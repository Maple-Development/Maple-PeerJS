<script lang="ts" module>
	/**
	 * waiting: not its turn yet. active: being sent, received or added. done: sent or added.
	 * skipped: already in the library. failed: it didn't make it. unreadable: this device
	 * couldn't read it, so it won't be sent.
	 */
	export type BatchTrackStatus =
		| 'waiting'
		| 'active'
		| 'done'
		| 'skipped'
		| 'failed'
		| 'unreadable';

	export interface BatchTrackRow {
		title: string;
		artist: string;
		/** Left out where nothing has happened yet (e.g. while picking a device). */
		status?: BatchTrackStatus;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The card for several tracks in the transfer popup: "N tracks" and their details, which
	 * opens to list every track and how far along each is.
	 */
	let {
		title,
		details,
		tracks
	}: {
		title: string;
		details: Snippet;
		/** Every track, in order. Without a list the card can't open. */
		tracks?: BatchTrackRow[];
	} = $props();

	let open = $state(false);
	const listId = $props.id();

	const STATUS_LABEL: Record<BatchTrackStatus, string> = {
		waiting: 'Waiting',
		active: 'In progress',
		done: 'Done',
		skipped: 'Already in your library',
		failed: 'Failed',
		unreadable: "Can't be read on this device"
	};

	// Keep the track in progress in view as the list moves along.
	function followActive(node: HTMLElement, active: boolean) {
		const scroll = (on: boolean) => {
			if (on) node.scrollIntoView({ block: 'nearest' });
		};
		scroll(active);
		return { update: scroll };
	}
</script>

<div class="bg-surface-container-highest overflow-hidden rounded-2xl">
	<button
		type="button"
		disabled={!tracks?.length}
		aria-expanded={open}
		aria-controls={listId}
		onclick={() => (open = !open)}
		class="hover:bg-on-surface/5 flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors disabled:cursor-default disabled:hover:bg-transparent"
	>
		<div
			class="bg-primary-container text-on-primary-container flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
			aria-hidden="true"
		>
			<svg width="20" height="20" viewBox="0 0 24 24">
				<path
					fill="currentColor"
					d="M12.5 15q1.05 0 1.775-.725T15 12.5V7h3V5h-4v5.5q-.325-.25-.7-.375T12.5 10q-1.05 0-1.775.725T10 12.5t.725 1.775T12.5 15M8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V6h2v14h14v2z"
				/>
			</svg>
		</div>
		<div class="min-w-0 flex-1">
			<p class="text-on-surface text-sm font-semibold [overflow-wrap:anywhere]">{title}</p>
			<p class="text-on-surface-variant text-xs [overflow-wrap:anywhere]">{@render details()}</p>
		</div>
		{#if tracks?.length}
			<span class="text-on-surface-variant flex shrink-0 items-center gap-0.5 text-xs font-medium">
				{open ? 'Hide' : 'Show'}
				<svg
					class={['transition-transform', open && 'rotate-180']}
					width="18"
					height="18"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path fill="currentColor" d="m12 15.4l-6-6L7.4 8l4.6 4.6L16.6 8L18 9.4z" />
				</svg>
			</span>
		{/if}
	</button>

	{#if open && tracks?.length}
		<ol
			id={listId}
			aria-label="Tracks"
			class="border-outline-variant/40 max-h-52 overflow-y-auto border-t px-1.5 py-1.5"
		>
			{#each tracks as track, i (i)}
				<li
					use:followActive={track.status === 'active'}
					class={[
						'flex items-center gap-2.5 rounded-lg px-1.5 py-1.5',
						track.status === 'active' && 'bg-secondary-container/50'
					]}
				>
					<span
						class="text-on-surface-variant w-5 shrink-0 text-right text-[11px] tabular-nums"
						aria-hidden="true">{i + 1}</span
					>
					<span
						class={[
							'min-w-0 flex-1',
							(track.status === 'waiting' || track.status === 'unreadable') && 'opacity-60'
						]}
					>
						<span class="text-on-surface block text-xs font-semibold [overflow-wrap:anywhere]"
							>{track.title || 'Untitled'}</span
						>
						<span class="text-on-surface-variant block text-[11px] [overflow-wrap:anywhere]"
							>{track.artist || 'Unknown artist'}</span
						>
					</span>
					{#if track.status && track.status !== 'waiting'}
						<span
							class="flex h-5 shrink-0 items-center"
							title={STATUS_LABEL[track.status]}
							aria-label={STATUS_LABEL[track.status]}
							role="img"
						>
							{#if track.status === 'active'}
								<span
									class="border-primary h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent"
								></span>
							{:else if track.status === 'done'}
								<svg class="text-primary" width="16" height="16" viewBox="0 0 24 24">
									<path
										fill="currentColor"
										d="M9.55 18L3.85 12.3l1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4z"
									/>
								</svg>
							{:else if track.status === 'skipped'}
								<span class="text-on-surface-variant text-[11px]">Already there</span>
							{:else if track.status === 'unreadable'}
								<span class="text-error text-[11px]">Can't read</span>
							{:else}
								<svg class="text-error" width="16" height="16" viewBox="0 0 24 24">
									<path
										fill="currentColor"
										d="M6.4 19L5 17.6l5.6-5.6L5 6.4L6.4 5l5.6 5.6L17.6 5L19 6.4L13.4 12l5.6 5.6l-1.4 1.4l-5.6-5.6z"
									/>
								</svg>
							{/if}
						</span>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</div>
