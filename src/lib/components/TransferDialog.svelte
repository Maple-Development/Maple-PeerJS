<script lang="ts">
	import { Button, Dialog, LinearProgress } from 'm3-svelte';
	import type { TransferFile } from '$shared/types/peer';
	import DeviceMessage from './DeviceMessage.svelte';
	import {
		answerOffer,
		cancelIncoming,
		cancelOutgoing,
		closeIncoming,
		closeOutgoing,
		confirmIncoming,
		formatSize,
		incomingTransfers,
		isOver,
		isReceived,
		isSent,
		outgoingOffers
	} from '$lib/devices';

	/** One transfer as the popup sees it, whichever way it's going. */
	interface Shown {
		id: string;
		/** in: another device is sending to this one. out: this device is sending. */
		direction: 'in' | 'out';
		status: 'pending' | 'answering' | 'accepted' | 'cancelled' | 'failed';
		file: TransferFile;
		/** The other device's name. */
		peer: string;
		/** Bytes received (in) or sent (out) so far. */
		bytes: number;
		/** Every byte has arrived (in) or gone out (out). */
		done: boolean;
		/** Waiting for the server to confirm a cancel. */
		cancelling: boolean;
		error?: string;
	}

	// One transfer at a time. Offers to this device come first, since they need an answer;
	// this device's own transfers show up here once the other side accepts.
	let current: Shown | undefined = $derived.by(() => {
		const incoming = $incomingTransfers[0];
		if (incoming) {
			return {
				id: incoming.offer.id,
				direction: 'in',
				status: incoming.status,
				file: incoming.offer.file,
				peer: incoming.offer.sender.name,
				bytes: incoming.received,
				done: isReceived(incoming),
				cancelling: !!incoming.cancelling,
				error: incoming.error
			};
		}
		// Pending offers are shown as a toast instead (see sendOffer in devices.ts), even while canceling.
		const outgoing = $outgoingOffers.find((o) => o.status !== 'pending');
		if (outgoing) {
			return {
				id: outgoing.transferId,
				direction: 'out',
				status: outgoing.status,
				file: outgoing.file,
				peer: outgoing.target.name,
				bytes: outgoing.sent,
				done: isSent(outgoing),
				cancelling: !!outgoing.cancelling,
				error: outgoing.error
			};
		}
		return undefined;
	});

	// Writable so the dialog can close itself; it reopens whenever another transfer is queued.
	let open = $derived(!!current);

	let over = $derived(!!current && isOver(current));
	let answered = $derived(current?.status === 'accepted' || over);
	let incoming = $derived(current?.direction === 'in');

	let headline = $derived(
		!current
			? ''
			: current.status === 'accepted'
				? incoming
					? current.done
						? 'Track received'
						: 'Receiving track'
					: current.done
						? 'Track sent'
						: 'Sending track'
				: current.status === 'cancelled'
					? 'Transfer canceled'
					: current.status === 'failed'
						? 'Transfer ended'
						: 'Incoming track'
	);

	// The text around the other device's name, which is shown in bold between the two.
	let progressText: [string, string] = $derived(
		!current
			? ['', '']
			: incoming
				? current.done
					? ['Received from ', '. Keep it?']
					: current.bytes === 0
						? ['Waiting for ', ' to start sending…']
						: ['Receiving from ', '…']
				: current.done
					? ['Sent to ', '.']
					: current.bytes === 0
						? ['Starting to send to ', '…']
						: ['Sending to ', '…']
	);

	let percent = $derived(
		current && current.file.size > 0 ? (current.bytes / current.file.size) * 100 : 0
	);

	// Only a transfer that has already ended can be dismissed with Esc or a click outside. The
	// others need a deliberate choice: closing an accepted one would cancel it.
	function close() {
		if (!current || !over) return;
		if (incoming) closeIncoming(current.id);
		else closeOutgoing(current.id);
	}

	function cancel(id: string) {
		if (incoming) void cancelIncoming(id);
		else void cancelOutgoing(id);
	}

	// The right-hand button once everything has arrived: the receiver keeps the track, the
	// sender is simply done.
	function finish(id: string) {
		if (incoming) void confirmIncoming(id);
		else closeOutgoing(id);
	}

	// Esc does nothing until the transfer has ended. closeOnEsc alone isn't enough: the popup
	// opens without a click from the user, and then the browser closes it on Esc anyway.
	// Stopping the key itself means the dialog never starts to close.
	function blockEsc(e: KeyboardEvent) {
		if (e.key === 'Escape' && current && !over) e.preventDefault();
	}

	// Closing an ended transfer can leave the next one hidden, and the browser may still close
	// the popup some other way. Show it again while anything is waiting.
	function reopen(e: Event) {
		if (!current) return;
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
	closeOnEsc={over}
	closeOnClick={over}
	onEsc={close}
	onClick={close}
	onclose={reopen}
>
	{#if current}
		<div class="flex w-80 max-w-full flex-col gap-4">
			{#if current.status === 'pending' || current.status === 'answering'}
				<p><DeviceMessage device={current.peer} after=" wants to send you a track." /></p>
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
					<span class="text-on-surface truncate font-medium" title={current.file.name}>
						{current.file.name}
					</span>
					<span class="text-on-surface-variant text-xs">
						{formatSize(current.file.size)}{#if answered}<DeviceMessage
								before=" {incoming ? 'from' : 'to'} "
								device={current.peer}
							/>{/if}
					</span>
				</div>
			</div>

			{#if current.status === 'accepted'}
				<div class="flex flex-col gap-2">
					<LinearProgress {percent} />
					<div class="text-on-surface-variant flex justify-between gap-3 text-xs">
						<span
							><DeviceMessage
								before={progressText[0]}
								device={current.peer}
								after={progressText[1]}
							/></span
						>
						<span class="flex-shrink-0"
							>{formatSize(current.bytes)} of {formatSize(current.file.size)}</span
						>
					</div>
				</div>
			{:else if current.status === 'cancelled'}
				<p class="text-on-surface-variant">{current.error}</p>
			{:else if current.status === 'failed'}
				<p class="text-error">{current.error}</p>
			{/if}
		</div>
	{/if}

	{#snippet buttons()}
		{#if current && !answered}
			{@const id = current.id}
			{@const busy = current.status === 'answering'}
			<Button variant="text" disabled={busy} onclick={() => answerOffer(id, false)}>Decline</Button>
			<Button variant="filled" disabled={busy} onclick={() => answerOffer(id, true)}>Accept</Button>
		{:else if current?.status === 'accepted'}
			{@const id = current.id}
			<!-- Cancel works until the whole file is across; after that the sender has nothing left
			     to cancel, while the receiver can still throw the file away. The other button only
			     works once the whole file is across. Both wait while the server confirms a cancel. -->
			{#if incoming || !current.done}
				<Button variant="text" disabled={current.cancelling} onclick={() => cancel(id)}
					>{current.cancelling ? 'Canceling…' : 'Cancel'}</Button
				>
			{/if}
			<Button
				variant="filled"
				disabled={!current.done || current.cancelling}
				onclick={() => finish(id)}>{incoming ? 'Confirm' : 'Done'}</Button
			>
		{:else}
			<Button variant="text" onclick={close}>Close</Button>
		{/if}
	{/snippet}
</Dialog>
