<script lang="ts">
	import { Button, Dialog, LinearProgress } from 'm3-svelte';
	import {
		answerOffer,
		cancelIncoming,
		closeIncoming,
		confirmIncoming,
		formatSize,
		incomingTransfers,
		isReceived
	} from '$lib/devices';

	// One offer at a time, oldest first; the rest wait their turn.
	let current = $derived($incomingTransfers[0]);
	// Writable so the dialog can close itself; it reopens whenever another offer is queued.
	let open = $derived(!!current);

	let answered = $derived(current?.status === 'accepted' || current?.status === 'failed');
	let received = $derived(!!current && isReceived(current));

	let headline = $derived(
		!current
			? ''
			: current.status === 'accepted'
				? received
					? 'Track received'
					: 'Receiving track'
				: current.status === 'failed'
					? 'Transfer stopped'
					: 'Incoming track'
	);

	let percent = $derived(
		current && current.offer.file.size > 0 ? (current.received / current.offer.file.size) * 100 : 0
	);

	// Only a failed offer can be dismissed with Esc or a click outside. The others need a
	// deliberate choice: closing an accepted one would cancel it.
	let failed = $derived(current?.status === 'failed');

	function close() {
		if (current && failed) closeIncoming(current.offer.id);
	}

	// Esc does nothing until the offer has failed. closeOnEsc alone isn't enough: the popup
	// opens without a click from the user, and then the browser closes it on Esc anyway.
	// Stopping the key itself means the dialog never starts to close.
	function blockEsc(e: KeyboardEvent) {
		if (e.key === 'Escape' && current && !failed) e.preventDefault();
	}

	// Closing a failed offer can leave the next one hidden, and the browser may still close
	// the popup some other way. Show it again while anything is waiting.
	function reopen(e: Event) {
		if ($incomingTransfers.length === 0) return;
		const dialog = e.currentTarget as HTMLDialogElement;
		if (!open)
			open = true; // the Dialog's own effect calls showModal
		else if (!dialog.open) dialog.showModal();
	}
</script>

<svelte:document onkeydowncapture={blockEsc} />

<Dialog
	bind:open
	{headline}
	closeOnEsc={failed}
	closeOnClick={failed}
	onEsc={close}
	onClick={close}
	onclose={reopen}
>
	{#if current}
		{@const { offer } = current}
		<div class="flex w-80 max-w-full flex-col gap-4">
			{#if current.status === 'pending' || current.status === 'answering'}
				<p><span class="font-medium">{offer.sender.name}</span> wants to send you a track.</p>
			{/if}

			<div class="bg-surface-container-highest flex items-center gap-3 rounded-2xl p-3">
				<div
					class="bg-primary-container text-on-primary-container flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
						<path
							fill="currentColor"
							d="M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V3h6v4h-4v10q0 1.65-1.175 2.825T10 21"
						/>
					</svg>
				</div>
				<div class="flex min-w-0 flex-col">
					<span class="text-on-surface truncate font-medium" title={offer.file.name}>
						{offer.file.name}
					</span>
					<span class="text-on-surface-variant text-xs">
						{formatSize(offer.file.size)}{answered ? ` from ${offer.sender.name}` : ''}
					</span>
				</div>
			</div>

			{#if current.status === 'accepted'}
				<!-- Placeholder: nothing updates `received` until the file transfer is built. -->
				<div class="flex flex-col gap-2">
					<LinearProgress {percent} />
					<div class="text-on-surface-variant flex justify-between gap-3 text-xs">
						<span>
							{received
								? `Received from ${offer.sender.name}. Keep it?`
								: current.received === 0
									? `Waiting for ${offer.sender.name} to start sending…`
									: `Receiving from ${offer.sender.name}…`}
						</span>
						<span class="flex-shrink-0"
							>{formatSize(current.received)} of {formatSize(offer.file.size)}</span
						>
					</div>
				</div>
			{:else if current.status === 'failed'}
				<p class="text-error">{current.error}</p>
			{/if}
		</div>
	{/if}

	{#snippet buttons()}
		{#if current && !answered}
			{@const id = current.offer.id}
			{@const busy = current.status === 'answering'}
			<Button variant="text" disabled={busy} onclick={() => answerOffer(id, false)}>Decline</Button>
			<Button variant="filled" disabled={busy} onclick={() => answerOffer(id, true)}>Accept</Button>
		{:else if current?.status === 'accepted'}
			{@const id = current.offer.id}
			<!-- Cancel works at any point; Confirm only once the whole file is here. -->
			<Button variant="text" onclick={() => cancelIncoming(id)}>Cancel</Button>
			<Button variant="filled" disabled={!received} onclick={() => confirmIncoming(id)}
				>Confirm</Button
			>
		{:else}
			<Button variant="text" onclick={close}>Close</Button>
		{/if}
	{/snippet}
</Dialog>
