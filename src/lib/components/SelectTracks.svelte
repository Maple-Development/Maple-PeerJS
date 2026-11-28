<script lang="ts">
	import { Button, Checkbox } from 'm3-svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { tracks } from '$lib/global.svelte';
	import { MAX_BATCH_TRACKS, tracksToSend } from '$lib/devices';

	/**
	 * Select mode on the Transfers tab: pick tracks from the library to send to another device
	 * at once. Sending opens the device picker (TransferDialog.svelte); `onclose` runs once
	 * they're sent, or when the user leaves select mode.
	 */
	let { onclose }: { onclose: () => void } = $props();

	let query = $state('');
	const selected = new SvelteSet<string>();

	const byTitle = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
	let library = $derived(
		[...tracks()].sort(
			(a, b) =>
				byTitle.compare(a.title || '', b.title || '') ||
				byTitle.compare(a.artist || '', b.artist || '')
		)
	);
	let shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return library;
		return library.filter((t) =>
			[t.title, t.artist, t.album].some((field) => field?.toLowerCase().includes(q))
		);
	});
	// A track removed from the library meanwhile drops out of the selection.
	let picked = $derived(library.filter((t) => selected.has(t.id)));
	let allShownSelected = $derived(shown.length > 0 && shown.every((t) => selected.has(t.id)));
	let tooMany = $derived(picked.length > MAX_BATCH_TRACKS);

	function toggle(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	function toggleShown() {
		const select = !allShownSelected;
		for (const t of shown) {
			if (select) selected.add(t.id);
			else selected.delete(t.id);
		}
	}

	function send() {
		if (!picked.length || tooMany) return;
		tracksToSend.set({ songs: picked, onSent: onclose });
	}
</script>

<section aria-label="Select tracks to send" class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<button
			type="button"
			onclick={onclose}
			aria-label="Stop selecting"
			title="Stop selecting"
			class="text-on-surface-variant hover:text-on-surface hover:bg-surface-container flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
				<path
					fill="currentColor"
					d="M6.4 19L5 17.6l5.6-5.6L5 6.4L6.4 5l5.6 5.6L17.6 5L19 6.4L13.4 12l5.6 5.6l-1.4 1.4l-5.6-5.6z"
				/>
			</svg>
		</button>
		<h2 class="text-on-surface mr-auto text-base font-bold">Select tracks to send</h2>
		<div
			class="bg-surface-container focus-within:bg-surface-container-high flex w-full min-w-0 items-center gap-2 rounded-full px-3.5 transition-colors sm:w-60"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				class="text-on-surface-variant shrink-0"
				aria-hidden="true"
			>
				<path
					fill="currentColor"
					d="m19.6 21l-6.3-6.3q-.75.6-1.725.95T9.5 16q-2.725 0-4.612-1.888T3 9.5t1.888-4.612T9.5 3t4.613 1.888T16 9.5q0 1.1-.35 2.075T14.7 13.3l6.3 6.3zM9.5 14q1.875 0 3.188-1.312T14 9.5t-1.312-3.187T9.5 5T6.313 6.313T5 9.5t1.313 3.188T9.5 14"
				/>
			</svg>
			<input
				type="search"
				bind:value={query}
				placeholder="Search tracks..."
				aria-label="Search tracks"
				class="text-on-surface placeholder:text-on-surface-variant/65 w-full border-none bg-transparent py-2 text-sm outline-none"
			/>
		</div>
	</div>

	{#if library.length === 0}
		<p class="text-on-surface-variant py-12 text-center text-sm">Your library has no tracks yet.</p>
	{:else}
		<div class="text-on-surface-variant flex items-center justify-between gap-3 px-1 text-xs">
			<button
				type="button"
				onclick={toggleShown}
				disabled={shown.length === 0}
				class="hover:text-on-surface cursor-pointer border-none bg-transparent font-semibold transition-colors disabled:cursor-default disabled:opacity-50"
			>
				{allShownSelected ? 'Deselect' : 'Select'}
				{query.trim() ? 'these' : 'all'}
			</button>
			<span>{shown.length} {shown.length === 1 ? 'track' : 'tracks'}</span>
		</div>

		{#if shown.length === 0}
			<p class="text-on-surface-variant py-12 text-center text-sm">No tracks match "{query}".</p>
		{:else}
			<ul class="bg-surface-container-low flex flex-col overflow-hidden rounded-2xl">
				{#each shown as track (track.id)}
					{@const checked = selected.has(track.id)}
					<li class="[contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]">
						<label
							class={[
								'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors select-none',
								checked ? 'bg-secondary-container/60' : 'hover:bg-surface-container'
							]}
						>
							<Checkbox>
								<input type="checkbox" {checked} onchange={() => toggle(track.id)} />
							</Checkbox>
							<span class="min-w-0 flex-1">
								<span
									class="text-on-surface block truncate text-sm font-semibold"
									title={track.title}>{track.title || 'Untitled'}</span
								>
								<span class="text-on-surface-variant block truncate text-xs"
									>{track.artist || 'Unknown artist'}{track.album ? ` · ${track.album}` : ''}</span
								>
							</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	<div
		class="bg-surface-container-high sticky bottom-24 z-10 mt-1 flex items-center gap-3 rounded-full py-2 pr-2 pl-5 shadow-md md:bottom-4"
	>
		<p class="text-on-surface min-w-0 flex-1 truncate text-sm" aria-live="polite">
			{#if tooMany}
				<span class="text-error">Pick up to {MAX_BATCH_TRACKS} tracks at once.</span>
			{:else}
				<span class="font-semibold">{picked.length}</span> selected
			{/if}
		</p>
		{#if picked.length}
			<Button variant="text" onclick={() => selected.clear()}>Clear</Button>
		{/if}
		<Button variant="filled" disabled={!picked.length || tooMany} onclick={send}>
			Send{picked.length ? ` ${picked.length}` : ''}
		</Button>
	</div>
</section>
