<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button, Dialog, LinearProgress } from 'm3-svelte';
	import { goto } from '$app/navigation';
	import type { TransferFile } from '$shared/types/peer';
	import { OPFS } from '$lib/opfs';
	import { openTrackFile } from '$lib/library';
	import { isLoggedIn } from '$lib/store';
	import DeviceMessage from './DeviceMessage.svelte';
	import {
		answerOffer,
		cancelIncoming,
		cancelOutgoing,
		closeIncoming,
		closeOutgoing,
		confirmIncoming,
		devices,
		formatSize,
		incomingTransfers,
		isOver,
		isReceived,
		isSent,
		outgoingOffers,
		renameSelf,
		selfId,
		sendOffer,
		trackToSend
	} from '$lib/devices';

	const MAX_NAME = 40;

	/** One transfer as the popup sees it, whichever way it's going. */
	interface Shown {
		id: string;
		/** in: another device is sending to this one. out: this device is sending. */
		direction: 'in' | 'out';
		status: 'pending' | 'answering' | 'accepted' | 'cancelled' | 'failed';
		file: TransferFile;
		/** What to call the track: its title when this device sent it, else the file name. */
		title: string;
		artist?: string;
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
				title: incoming.offer.file.name,
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
				title: outgoing.label,
				artist: outgoing.track.artist || undefined,
				peer: outgoing.target.name,
				bytes: outgoing.sent,
				done: isSent(outgoing),
				cancelling: !!outgoing.cancelling,
				error: outgoing.error
			};
		}
		return undefined;
	});

	// Picking a device for "Send to Device". A transfer that needs the popup goes first: an
	// offer that arrives mid-pick is answered, then the picker comes back.
	let picking = $derived(!current && !!$trackToSend);

	// Writable so the dialog can close itself; it reopens whenever another transfer is queued.
	let open = $derived(!!current || picking);

	let over = $derived(!!current && isOver(current));
	let answered = $derived(current?.status === 'accepted' || over);
	let incoming = $derived(current?.direction === 'in');

	let headline = $derived(
		picking
			? 'Send track'
			: !current
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

	/** This account's other online devices, which the picker offers to send to. */
	let targets = $derived($devices.filter((d) => d.id !== $selfId));
	let self = $derived($devices.find((d) => d.id === $selfId));
	let pickedId = $state<string | null>(null);
	// The first device is picked until the user picks another, or if theirs goes offline.
	let target = $derived(targets.find((d) => d.id === pickedId) ?? targets[0]);

	/** The track's file: undefined while it loads, null if it couldn't be read. */
	let songFile = $state<Blob | null>();
	let artwork = $state<string>();
	let sending = $state(false);
	let sendError = $state<string>();
	let renaming = $state(false);
	let draftName = $state('');

	// Start each pick fresh, and load the track's file (its size is shown, and it's what gets
	// sent) and its artwork.
	$effect(() => {
		const song = $trackToSend;
		pickedId = null;
		songFile = undefined;
		artwork = undefined;
		sendError = undefined;
		renaming = false;
		if (!song) return;

		let stale = false;
		openTrackFile(song).then(
			(file) => {
				if (!stale) songFile = file ?? null;
			},
			() => {
				if (!stale) songFile = null;
			}
		);
		let ownUrl: string | undefined;
		if (song.image instanceof Blob) {
			artwork = ownUrl = URL.createObjectURL(song.image);
		} else if (song.image) {
			OPFS.getImageUrl(song.image).then(
				(url) => {
					if (!stale) artwork = url;
				},
				() => {}
			);
		}
		return () => {
			stale = true;
			if (ownUrl) URL.revokeObjectURL(ownUrl);
		};
	});

	async function sendPicked() {
		const song = $trackToSend;
		const to = target;
		const data = songFile;
		if (!song || !to || !data || sending) return;
		sending = true;
		sendError = undefined;
		// The file goes with the offer; devices.ts sends it once the other device accepts.
		const reply = await sendOffer(
			to,
			{ name: song.fileName || `${song.title}.${song.ext}`, size: data.size, type: data.type },
			data,
			song,
			song.title
		);
		sending = false;
		// From here a "waiting" notice (from sendOffer) takes over until the other device answers.
		if (reply.ok) {
			if ($trackToSend === song) trackToSend.set(null);
		} else {
			sendError = reply.error;
		}
	}

	function signIn() {
		trackToSend.set(null);
		goto('/login');
	}

	function startRename() {
		if (!self) return;
		draftName = self.name;
		renaming = true;
	}

	function saveRename() {
		if (!renaming) return;
		renaming = false;
		renameSelf(draftName);
	}

	function onRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveRename();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			renaming = false;
		}
	}

	function focusAndSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	// The picker can always be dismissed (except while renaming, where Esc only cancels that).
	// A transfer only once it has ended: the others need a deliberate choice, and closing an
	// accepted one would cancel it.
	let dismissable = $derived(current ? over : !renaming);

	function close() {
		if (!current) {
			trackToSend.set(null);
			return;
		}
		if (!over) return;
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
	// Stopping the key itself means the dialog never starts to close. The rename field still
	// sees the key, and cancels the rename.
	function blockEsc(e: KeyboardEvent) {
		if (e.key === 'Escape' && (current ? !over : renaming)) e.preventDefault();
	}

	// Closing an ended transfer can leave the next one hidden, and the browser may still close
	// the popup some other way. Show it again while anything is waiting.
	function reopen(e: Event) {
		if (!current && !picking) return;
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
	closeOnEsc={dismissable}
	closeOnClick={dismissable}
	onEsc={close}
	onClick={close}
	onclose={reopen}
	style={picking ? 'width: min(31rem, calc(100vw - 2rem));' : undefined}
>
	{#if current}
		{@const shown = current}
		<div class="flex w-80 max-w-full flex-col gap-4">
			{#if shown.status === 'pending' || shown.status === 'answering'}
				<p><DeviceMessage device={shown.peer} after=" wants to send you a track." /></p>
			{/if}

			{#snippet transferDetails()}
				{shown.artist ? `${shown.artist} · ` : ''}{formatSize(
					shown.file.size
				)}{#if answered}<DeviceMessage
						before=" {incoming ? 'from' : 'to'} "
						device={shown.peer}
					/>{/if}
			{/snippet}
			{@render trackCard(shown.title, undefined, transferDetails)}

			{#if shown.status === 'accepted'}
				<div class="flex flex-col gap-2">
					<LinearProgress {percent} />
					<div class="text-on-surface-variant flex justify-between gap-3 text-xs">
						<span
							><DeviceMessage
								before={progressText[0]}
								device={shown.peer}
								after={progressText[1]}
							/></span
						>
						<span class="flex-shrink-0"
							>{formatSize(shown.bytes)} of {formatSize(shown.file.size)}</span
						>
					</div>
				</div>
			{:else if shown.status === 'cancelled'}
				<p class="text-on-surface-variant">{shown.error}</p>
			{:else if shown.status === 'failed'}
				<p class="text-error">{shown.error}</p>
			{/if}
		</div>
	{:else if picking && $trackToSend}
		{@const song = $trackToSend}
		<div class="flex flex-col gap-4">
			{#snippet songDetails()}
				{song.artist || 'Unknown artist'}{songFile ? ` · ${formatSize(songFile.size)}` : ''}
			{/snippet}
			{@render trackCard(song.title || 'Untitled', artwork, songDetails)}

			{#if !$isLoggedIn}
				<p class="text-on-surface-variant text-sm">Sign in to send tracks to your other devices.</p>
			{:else}
				<div class="flex flex-col gap-2" role="group" aria-label="Your devices">
					<div
						class="text-on-surface-variant flex min-h-7 items-center justify-between gap-2 text-xs"
					>
						<span class="font-semibold">Your devices</span>
						<!-- The server only lets a device rename itself. -->
						{#if self && renaming}
							<input
								use:focusAndSelect
								bind:value={draftName}
								onkeydown={onRenameKeydown}
								onblur={saveRename}
								maxlength={MAX_NAME}
								aria-label="This device's name"
								class="text-on-surface border-outline focus:border-primary bg-surface-container-highest w-44 min-w-0 rounded-lg border px-2 py-1 text-xs outline-none"
							/>
						{:else if self}
							<button
								type="button"
								onclick={startRename}
								title="Rename this device"
								class="hover:text-on-surface inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-full px-1 py-0.5 transition-colors"
							>
								<span class="truncate"
									><DeviceMessage before="Sending from " device={self.name} /></span
								>
								<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
									<path
										fill="currentColor"
										d="M5 19h1.425L16.2 9.225L14.775 7.8L5 17.575zm-2 2v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.438.65T21 6.4q0 .4-.137.763t-.438.662L7.25 21z"
									/>
								</svg>
							</button>
						{/if}
					</div>

					{#if targets.length}
						<div class="flex flex-wrap gap-1.5">
							{#each targets as device (device.id)}
								{@const active = target?.id === device.id}
								<button
									type="button"
									aria-pressed={active}
									onclick={() => (pickedId = device.id)}
									class={[
										'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
										active
											? 'bg-secondary-container text-on-secondary-container border-primary/40'
											: 'bg-surface-container text-on-surface-variant hover:text-on-surface border-transparent'
									]}
								>
									<svg
										class="shrink-0"
										width="13"
										height="13"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<!-- Material-style icons: a phone (camera and side button) or a laptop. -->
										<path
											fill="currentColor"
											d={device.kind === 'mobile'
												? 'M6 23q-.425 0-.712-.288T5 22V2q0-.425.288-.712T6 1h12q.425 0 .713.288T19 2v20q0 .425-.288.713T18 23zm1-2h10V3H7zm5-15q.425 0 .713-.288T13 5t-.288-.712T12 4t-.712.288T11 5t.288.713T12 6m7 5V6h1v5z'
												: 'M2 21q-.425 0-.712-.288T1 20t.288-.712T2 19h20q.425 0 .713.288T23 20t-.288.713T22 21zm3-3q-.825 0-1.412-.587T3 16V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v11q0 .825-.587 1.413T19 18zm0-2h14V5H5z'}
										/>
									</svg>
									<span class="truncate" title={device.name}>{device.name}</span>
								</button>
							{/each}
						</div>
					{:else}
						<p class="text-on-surface-variant text-xs">
							No other devices are online. Open Maple on another device signed in to this account.
						</p>
					{/if}
				</div>
			{/if}

			{#if songFile === null}
				<p class="text-error text-xs">Couldn't read "{song.title}" from this device.</p>
			{:else if sendError}
				<p class="text-error text-xs">{sendError}</p>
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
			<!-- Cancel works until the transfer completes; after that the sender has nothing left
			     to cancel, while the receiver can still throw the file away. The other button only
			     works once it completes. Both wait while the server confirms a cancel. -->
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
		{:else if current}
			<Button variant="text" onclick={close}>Close</Button>
		{:else if picking}
			<Button variant="text" onclick={close}>Cancel</Button>
			{#if $isLoggedIn}
				<Button variant="filled" onclick={sendPicked} disabled={!target || !songFile || sending}>
					{sending ? 'Sending…' : target ? `Send to ${target.name}` : 'Send'}
				</Button>
			{:else}
				<Button variant="filled" onclick={signIn}>Sign in</Button>
			{/if}
		{/if}
	{/snippet}
</Dialog>

{#snippet trackCard(title: string, artwork: string | undefined, details: Snippet)}
	<div class="bg-surface-container-highest flex items-center gap-3 rounded-2xl p-3">
		{#if artwork}
			<img src={artwork} alt="" class="h-11 w-11 shrink-0 rounded-xl object-cover" />
		{:else}
			<div
				class="bg-primary-container text-on-primary-container flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
				aria-hidden="true"
			>
				<svg width="20" height="20" viewBox="0 0 24 24">
					<path
						fill="currentColor"
						d="M12 5v8.55c-.94-.54-2.1-.75-3.33-.32c-1.34.48-2.37 1.67-2.61 3.07a4.007 4.007 0 0 0 4.59 4.65c1.96-.31 3.35-2.11 3.35-4.1V7h2c1.1 0 2-.9 2-2s-.9-2-2-2h-2c-1.1 0-2 .9-2 2"
					/>
				</svg>
			</div>
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-on-surface truncate text-sm font-semibold" {title}>{title}</p>
			<p class="text-on-surface-variant truncate text-xs">{@render details()}</p>
		</div>
	</div>
{/snippet}
