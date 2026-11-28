<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { Button, Dialog, LinearProgress } from 'm3-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { TransferFile } from '$shared/types/peer';
	import { OPFS } from '$lib/opfs';
	import { IFS } from '$lib/ifs';
	import UserSettings, { INTERNAL_LOCATION } from '$lib/preferences/usersettings';
	import { openTrackFile } from '$lib/library';
	import { isLoggedIn, socialTab } from '$lib/store';
	import DeviceMessage from './DeviceMessage.svelte';
	import SelectMenu from './SelectMenu.svelte';
	import BatchTracks, { type BatchTrackRow } from './BatchTracks.svelte';
	import {
		acceptBatch,
		albumToSend,
		answerOffer,
		cancelIncoming,
		cancelIncomingBatch,
		cancelOutgoing,
		cancelOutgoingBatch,
		closeIncoming,
		closeIncomingBatch,
		closeOutgoing,
		closeOutgoingBatch,
		confirmIncoming,
		declineBatch,
		devices,
		formatSize,
		incomingBatches,
		incomingTransfers,
		isBatchOver,
		isOver,
		isReceived,
		isSent,
		openPlaylist,
		outgoingBatch,
		outgoingOffers,
		playlistToSend,
		renameSelf,
		selfId,
		sendBatch,
		sendOffer,
		tracksToSend,
		transferHistory,
		type BatchDuplicateChoice,
		type IncomingBatch,
		type OutgoingBatch,
		type OutgoingBatchItem
	} from '$lib/devices';

	const MAX_NAME = 40;

	// Once a transfer succeeds (sent, or added to this library), go to the Social page's
	// Transfers tab, where finished transfers are listed. Declined, canceled and failed ones are
	// listed too, but don't navigate away from what the user is doing.
	// A batch does so once it's done rather than after its first track.
	let lastFinishedId: string | undefined;
	$effect(() => {
		const latest = $transferHistory[0];
		if (!latest || latest.id === lastFinishedId) return;
		lastFinishedId = latest.id;
		if (latest.batch || (latest.outcome !== 'sent' && latest.outcome !== 'imported')) return;
		showTransfers();
	});
	let lastDoneBatch: string | undefined;
	$effect(() => {
		const done = [batchIn, batchOut].find(
			(b) =>
				b?.status === 'done' &&
				(('imported' in b && b.imported > 0) || ('items' in b && b.sent > 0))
		);
		if (!done || done.id === lastDoneBatch) return;
		lastDoneBatch = done.id;
		showTransfers();
	});

	function showTransfers() {
		socialTab.set('transfers');
		if (untrack(() => page.url.pathname) !== resolve('/friends')) goto(resolve('/friends'));
	}

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
		/** Incoming only: the library already has this track (see IncomingTransfer). */
		duplicate?: { title: string; artist: string; linked: boolean };
		error?: string;
	}

	// One thing at a time. Offers to this device come first, since they need an answer (a batch,
	// several tracks at once, before a single track); this device's own transfers show up here
	// once the other side accepts. Files that are part of a batch are shown by their batch.
	let batchIn: IncomingBatch | undefined = $derived($incomingBatches[0]);
	let singleIn = $derived($incomingTransfers.find((t) => !t.batchId));
	let batchOut: OutgoingBatch | undefined = $derived(
		$outgoingBatch && $outgoingBatch.status !== 'offered' ? $outgoingBatch : undefined
	);
	let showBatchOut = $derived(!batchIn && !singleIn && !!batchOut);

	let current: Shown | undefined = $derived.by(() => {
		if (batchIn) return undefined;
		const incoming = singleIn;
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
				duplicate: incoming.duplicate,
				error: incoming.error
			};
		}
		if (batchOut) return undefined;
		// Pending offers are shown as a toast instead (see sendOffer in devices.ts), even while canceling.
		const outgoing = $outgoingOffers.find((o) => !o.batchId && o.status !== 'pending');
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

	// Picking a device to send tracks to. A transfer that needs the popup goes first: an
	// offer that arrives mid-pick is answered, then the picker comes back.
	let picking = $derived(!current && !batchIn && !showBatchOut && !!$tracksToSend);
	/**
	 * The tracks being picked for, and the album or playlist they are when it's one of those
	 * being sent.
	 */
	let songs = $derived($tracksToSend?.songs ?? []);
	let pickedAlbum = $derived($tracksToSend?.album);
	let pickedPlaylist = $derived($tracksToSend?.playlist);

	// Writable so the dialog can close itself; it reopens whenever another transfer is queued.
	let open = $derived(!!current || picking || !!batchIn || showBatchOut);

	let over = $derived(!!current && isOver(current));
	let answered = $derived(current?.status === 'accepted' || over);
	let incoming = $derived(current?.direction === 'in');

	// The batch being sent or received, and the bytes of it that have gone so far (the files
	// that are done plus the one in progress).
	let batchInBytes = $derived(
		batchIn
			? batchIn.doneBytes +
					($incomingTransfers.find((t) => t.offer.id === batchIn.transferId)?.received ?? 0)
			: 0
	);
	let batchOutSize = $derived(batchOut?.items.reduce((sum, i) => sum + i.file.size, 0) ?? 0);
	let batchOutBytes = $derived(
		batchOut
			? batchOut.doneBytes +
					($outgoingOffers.find((o) => o.transferId === batchOut.transferId)?.sent ?? 0)
			: 0
	);

	function batchHeadline(status: string, receiving: boolean) {
		switch (status) {
			case 'pending':
			case 'answering':
				return 'Incoming tracks';
			case 'receiving':
				return 'Receiving tracks';
			case 'sending':
				return 'Sending tracks';
			case 'done':
				return receiving ? 'Tracks received' : 'Tracks sent';
			case 'cancelled':
				return 'Transfer canceled';
			default:
				return 'Transfer ended';
		}
	}

	/** How a batch's files went so far, e.g. "10 added to your library · 2 already there". */
	function incomingSummary(batch: IncomingBatch) {
		return [
			batch.imported &&
				`${batch.imported} added to your library${batch.folderName ? ` in “${batch.folderName}”` : ''}`,
			batch.skipped && `${batch.skipped} already there`,
			batch.failed && `${batch.failed} failed`
		]
			.filter(Boolean)
			.join(' · ');
	}

	function outgoingSummary(batch: OutgoingBatch) {
		return [
			batch.sent && `${batch.sent} sent`,
			batch.failed && `${batch.failed} failed`,
			batch.unreadable && `${batch.unreadable} couldn't be read on this device`
		]
			.filter(Boolean)
			.join(' · ');
	}

	const DUPLICATE_OPTIONS: { id: BatchDuplicateChoice; name: string }[] = [
		{ id: 'skip', name: 'Skip them' },
		{ id: 'keep-both', name: 'Keep both' },
		{ id: 'replace', name: 'Replace them' }
	];
	let batchDuplicates = $state<BatchDuplicateChoice>('skip');

	let headline = $derived(
		batchIn
			? batchHeadline(batchIn.status, true)
			: showBatchOut && batchOut
				? batchHeadline(batchOut.status, false)
				: picking
					? pickedAlbum
						? 'Send album'
						: pickedPlaylist
							? 'Send playlist'
							: songs.length > 1
							? 'Send tracks'
							: 'Send track'
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
					? ['Received from ', current.duplicate ? '.' : '. Keep it?']
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

	// Where an incoming track is saved: Maple's own storage or one of the library's linked
	// (external) folders. Starts at the default from Settings for each offer; the user can pick
	// another.
	const linkedFolders = IFS.linkedFolders;
	let saveOptions = $derived([
		{ id: INTERNAL_LOCATION, name: 'Internal storage' },
		...[...$linkedFolders]
			.sort((a, b) => a.handle.name.localeCompare(b.handle.name))
			.map((f) => ({ id: f.id, name: f.handle.name }))
	]);
	let pickedLocation = $state<string>(INTERNAL_LOCATION);
	// The offer being answered: a batch waiting for an answer, or a single incoming track.
	let incomingId = $derived(
		batchIn
			? batchIn.status === 'pending'
				? batchIn.id
				: undefined
			: incoming
				? current?.id
				: undefined
	);
	$effect(() => {
		if (!incomingId) return;
		pickedLocation = UserSettings.preferences.transferLocation;
		batchDuplicates = 'skip';
		IFS.loadFolders().catch(() => {});
	});
	// A folder that was unlinked since falls back to internal storage.
	let saveLocation = $derived(
		saveOptions.some((o) => o.id === pickedLocation) ? pickedLocation : INTERNAL_LOCATION
	);

	/** This account's other online devices, which the picker offers to send to. */
	let targets = $derived($devices.filter((d) => d.id !== $selfId));
	let self = $derived($devices.find((d) => d.id === $selfId));
	let pickedId = $state<string | null>(null);
	// The first device is picked until the user picks another, or if theirs goes offline.
	let target = $derived(targets.find((d) => d.id === pickedId) ?? targets[0]);

	/** One file per track being picked for, once loaded (null if it couldn't be read). */
	let songFiles = $state<(File | null)[]>();
	/** The single track's file: undefined while it loads, null if it couldn't be read. */
	let songFile = $derived(songFiles?.[0]);
	let readableCount = $derived(songFiles?.filter(Boolean).length ?? 0);
	let unreadableCount = $derived(songFiles ? songFiles.length - readableCount : 0);
	let pickedSize = $derived(songFiles?.reduce((sum, f) => sum + (f?.size ?? 0), 0) ?? 0);

	// Each batch's tracks for its card's list, and how far along each one is.
	let pickedRows: BatchTrackRow[] = $derived(
		songs.map((s, i) => ({
			title: s.title,
			artist: s.artist,
			status: songFiles?.[i] === null ? 'unreadable' : undefined
		}))
	);
	let batchInRows: BatchTrackRow[] | undefined = $derived(
		batchIn?.tracks?.map((track, i) => {
			const result = batchIn.results[i];
			const status =
				result === 'imported'
					? 'done'
					: result
						? result
						: batchIn.status === 'pending' || batchIn.status === 'answering'
							? undefined
							: i < batchIn.settled || (i === batchIn.position && batchIn.transferId)
								? 'active'
								: 'waiting';
			return { ...track, status };
		})
	);
	let batchOutRows: BatchTrackRow[] | undefined = $derived(
		batchOut?.items.map(({ song }, i) => {
			const result = batchOut.results[i];
			const status =
				result === 'sent'
					? 'done'
					: result
						? result
						: i === batchOut.index && batchOut.status === 'sending'
							? 'active'
							: 'waiting';
			return { title: song.title, artist: song.artist, status };
		})
	);
	let artwork = $state<string>();
	let sending = $state(false);
	let sendError = $state<string>();
	let renaming = $state(false);
	let draftName = $state('');

	// Start each pick fresh, and load the tracks' files (their size is shown, and they're what
	// gets sent) and, for one track, an album or a playlist, its artwork.
	$effect(() => {
		const picked = $tracksToSend?.songs ?? [];
		const pickedAlbumNow = $tracksToSend?.album;
		const pickedPlaylistNow = $tracksToSend?.playlist;
		pickedId = null;
		songFiles = undefined;
		artwork = undefined;
		sendError = undefined;
		renaming = false;
		if (!picked.length) return;

		let stale = false;
		Promise.all(
			picked.map((s) =>
				openTrackFile(s).then(
					(file) => file ?? null,
					() => null
				)
			)
		).then((files) => {
			if (!stale) songFiles = files;
		});
		const collection = pickedAlbumNow ?? pickedPlaylistNow;
		const image = collection ? collection.image : picked[0].image;
		if (picked.length > 1 && !collection) {
			return () => {
				stale = true;
			};
		}
		let ownUrl: string | undefined;
		if (image instanceof Blob) {
			artwork = ownUrl = URL.createObjectURL(image);
		} else if (image) {
			OPFS.getImageUrl(image).then(
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
		const picked = $tracksToSend;
		const to = target;
		const files = songFiles;
		if (!picked || !to || !files || sending) return;
		// Tracks that couldn't be read are left out.
		const items: OutgoingBatchItem[] = picked.songs.flatMap((song, i) => {
			const data = files[i];
			if (!data) return [];
			const name = song.fileName || `${song.title}.${song.ext}`;
			return [{ song, label: song.title, data, file: { name, size: data.size, type: data.type } }];
		});
		if (!items.length) return;
		sending = true;
		sendError = undefined;
		// An album's metadata and cover go with each of its tracks; so do a playlist's, for the
		// other device to make the playlist from them.
		const collection = {
			album: picked.album ? await albumToSend(picked.album) : undefined,
			playlist: picked.playlist ? await playlistToSend(picked.playlist) : undefined
		};
		// The files go with the offer; devices.ts sends them once the other device accepts.
		const reply =
			items.length === 1
				? await sendOffer(
						to,
						items[0].file,
						items[0].data,
						items[0].song,
						items[0].label,
						undefined,
						collection
					)
				: await sendBatch(to, items, picked.songs.length - items.length, collection);
		sending = false;
		// From here a "waiting" notice takes over until the other device answers.
		if (reply.ok) {
			if ($tracksToSend === picked) tracksToSend.set(null);
			picked.onSent?.();
		} else {
			sendError = reply.error;
		}
	}

	function signIn() {
		tracksToSend.set(null);
		goto(resolve('/login'));
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
	// A transfer or batch only once it has ended: the others need a deliberate choice, and
	// closing an accepted one would cancel it.
	let dismissable = $derived(
		batchIn
			? isBatchOver(batchIn)
			: showBatchOut && batchOut
				? isBatchOver(batchOut)
				: current
					? over
					: !renaming
	);

	function close() {
		if (batchIn) {
			closeIncomingBatch(batchIn.id);
			return;
		}
		if (showBatchOut) {
			closeOutgoingBatch();
			return;
		}
		if (!current) {
			tracksToSend.set(null);
			return;
		}
		if (!over) return;
		if (incoming) closeIncoming(current.id);
		else closeOutgoing(current.id);
	}

	/**
	 * Close a received playlist's batch and go to the playlist. Takes the ID as an argument: a
	 * {@const} in the markup is read lazily, and close() takes away the batch it comes from.
	 */
	function openReceivedPlaylist(playlistId: string) {
		close();
		void openPlaylist(playlistId);
	}

	function cancel(id: string) {
		if (incoming) void cancelIncoming(id);
		else void cancelOutgoing(id);
	}

	// The right-hand button once everything has arrived: the receiver keeps the track, the
	// sender is simply done.
	function finish(id: string) {
		if (incoming) void confirmIncoming(id, { location: saveLocation });
		else closeOutgoing(id);
	}

	// Esc does nothing until the transfer has ended. closeOnEsc alone isn't enough: the popup
	// opens without a click from the user, and then the browser closes it on Esc anyway.
	// Stopping the key itself means the dialog never starts to close. The rename field still
	// sees the key, and cancels the rename.
	function blockEsc(e: KeyboardEvent) {
		if (e.key === 'Escape' && open && !dismissable) e.preventDefault();
	}

	// Closing an ended transfer can leave the next one hidden, and the browser may still close
	// the popup some other way. Show it again while anything is waiting.
	function reopen(e: Event) {
		if (!current && !picking && !batchIn && !showBatchOut) return;
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
	{#if batchIn}
		{@const batch = batchIn}
		{@const answering = batch.status === 'pending' || batch.status === 'answering'}
		{@const summary = incomingSummary(batch)}
		<div class="flex w-80 max-w-full flex-col gap-4">
			{#if answering}
				<p>
					<DeviceMessage
						device={batch.sender.name}
						after={batch.album
							? ` wants to send you the album “${batch.album}” (${batch.count} tracks).`
							: batch.playlist
								? ` wants to send you the playlist “${batch.playlist}” (${batch.count} tracks).`
								: ` wants to send you ${batch.count} tracks.`}
					/>
				</p>
			{/if}

			{#snippet batchInDetails()}
				{batch.album || batch.playlist ? `${batch.count} tracks · ` : ''}{formatSize(
					batch.size
				)}{#if !answering}<DeviceMessage
						before=" from "
						device={batch.sender.name}
					/>{/if}
			{/snippet}
			<BatchTracks
				title={batch.album ?? batch.playlist ?? `${batch.count} tracks`}
				details={batchInDetails}
				tracks={batchInRows}
			/>

			{#if answering}
				{#if saveOptions.length > 1}
					<div class="text-on-surface-variant flex items-center justify-between gap-3 text-xs">
						<label for="transfer-save-to" class="font-semibold">Save to</label>
						<SelectMenu
							id="transfer-save-to"
							size="sm"
							options={saveOptions}
							bind:value={() => saveLocation, (v) => (pickedLocation = v)}
							disabled={batch.status === 'answering'}
							class="max-w-52"
						/>
					</div>
				{/if}
				<div class="text-on-surface-variant flex items-center justify-between gap-3 text-xs">
					<label for="transfer-duplicates" class="font-semibold">Tracks you already have</label>
					<SelectMenu
						id="transfer-duplicates"
						size="sm"
						options={DUPLICATE_OPTIONS}
						bind:value={() => batchDuplicates, (v) => (batchDuplicates = v as BatchDuplicateChoice)}
						disabled={batch.status === 'answering'}
						class="max-w-52"
					/>
				</div>
			{:else if batch.status === 'receiving'}
				{@const arriving = batch.settled < batch.count}
				<div class="flex flex-col gap-2">
					<LinearProgress percent={batch.size > 0 ? (batchInBytes / batch.size) * 100 : 0} />
					<div class="text-on-surface-variant flex justify-between gap-3 text-xs">
						<span
							>{#if arriving}<DeviceMessage
									before="Receiving {batch.settled + 1} of {batch.count} from "
									device={batch.sender.name}
									after="…"
								/>{:else}Adding to your library…{/if}</span
						>
						<span class="flex-shrink-0">{formatSize(batchInBytes)} of {formatSize(batch.size)}</span
						>
					</div>
				</div>
			{/if}

			{#if !answering && summary}
				<p class="text-on-surface-variant text-sm">{summary}.</p>
			{/if}
			{#if batch.playlistId}
				<p class="text-on-surface-variant text-sm">
					They're in the playlist <span class="text-on-surface font-semibold"
						>{batch.playlist}</span
					>.
				</p>
			{/if}
			{#if batch.status === 'receiving'}
				<p class="text-on-surface-variant text-xs">
					{batch.playlist
						? 'Canceling stops the rest. Tracks already added stay in your library, and go in the playlist.'
						: 'Canceling stops the rest. Tracks already added stay in your library.'}
				</p>
			{:else if batch.status === 'cancelled'}
				<p class="text-on-surface-variant">{batch.error}</p>
			{:else if batch.status === 'failed'}
				<p class="text-error">{batch.error}</p>
			{/if}
		</div>
	{:else if showBatchOut && batchOut}
		{@const batch = batchOut}
		{@const summary = outgoingSummary(batch)}
		<div class="flex w-80 max-w-full flex-col gap-4">
			{#snippet batchOutDetails()}
				{batch.album || batch.playlist ? `${batch.items.length} tracks · ` : ''}{formatSize(
					batchOutSize
				)}<DeviceMessage
					before=" to "
					device={batch.target.name}
				/>
			{/snippet}
			<BatchTracks
				title={batch.album?.metadata.name ??
					batch.playlist?.metadata.name ??
					`${batch.items.length} tracks`}
				details={batchOutDetails}
				tracks={batchOutRows}
			/>

			{#if batch.status === 'sending'}
				{@const item = batch.items[batch.index]}
				<div class="flex flex-col gap-2">
					<LinearProgress percent={batchOutSize > 0 ? (batchOutBytes / batchOutSize) * 100 : 0} />
					<div class="text-on-surface-variant flex justify-between gap-3 text-xs">
						<span class="min-w-0 [overflow-wrap:anywhere]"
							><DeviceMessage
								before="Sending {batch.index + 1} of {batch.items.length} to "
								device={batch.target.name}
								after="…"
							/></span
						>
						<span class="flex-shrink-0"
							>{formatSize(batchOutBytes)} of {formatSize(batchOutSize)}</span
						>
					</div>
				</div>
			{/if}

			{#if summary}
				<p class="text-on-surface-variant text-sm">{summary}.</p>
			{/if}
			{#if batch.status === 'cancelled'}
				<p class="text-on-surface-variant">{batch.error}</p>
			{:else if batch.status === 'failed'}
				<p class="text-error">{batch.error}</p>
			{/if}
		</div>
	{:else if current}
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

			{#if incoming && !over && saveOptions.length > 1}
				<div class="text-on-surface-variant flex items-center justify-between gap-3 text-xs">
					<label for="transfer-save-to" class="font-semibold">Save to</label>
					<SelectMenu
						id="transfer-save-to"
						size="sm"
						options={saveOptions}
						bind:value={() => saveLocation, (v) => (pickedLocation = v)}
						disabled={shown.cancelling}
						class="max-w-52"
					/>
				</div>
			{/if}

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
				{#if incoming && shown.done && shown.duplicate}
					<p class="text-on-surface-variant text-sm">
						You already have <span class="text-on-surface font-semibold"
							>{shown.duplicate.title}</span
						>{shown.duplicate.artist ? ` by ${shown.duplicate.artist}` : ''}. Keep both, or
						replace the one you have? Replacing keeps its place in your playlists{shown.duplicate
							.linked
							? ', and removes the old one from your library but not from its linked folder'
							: ''}.
					</p>
				{/if}
			{:else if shown.status === 'cancelled'}
				<p class="text-on-surface-variant">{shown.error}</p>
			{:else if shown.status === 'failed'}
				<p class="text-error">{shown.error}</p>
			{/if}
		</div>
	{:else if picking && songs.length}
		{@const song = songs[0]}
		{@const multi = songs.length > 1}
		<div class="flex flex-col gap-4">
			{#if pickedAlbum}
				{@const albumArtist = pickedAlbum.artist || 'Unknown artist'}
				{#snippet albumDetails()}
					{albumArtist} · {songs.length}
					{songs.length === 1 ? 'track' : 'tracks'}{songFiles ? ` · ${formatSize(pickedSize)}` : ''}
				{/snippet}
				{@render trackCard(pickedAlbum.name || 'Untitled album', artwork, albumDetails)}
			{:else if pickedPlaylist}
				{#snippet playlistDetails()}
					Playlist · {songs.length}
					{songs.length === 1 ? 'track' : 'tracks'}{songFiles ? ` · ${formatSize(pickedSize)}` : ''}
				{/snippet}
				{@render trackCard(pickedPlaylist.name || 'Untitled playlist', artwork, playlistDetails)}
			{:else if multi}
				{@const artists = new Set(songs.map((s) => s.artist || 'Unknown artist'))}
				{#snippet tracksDetails()}
					{artists.size === 1 ? [...artists][0] : `${artists.size} artists`}{songFiles
						? ` · ${formatSize(pickedSize)}`
						: ''}
				{/snippet}
				<BatchTracks title="{songs.length} tracks" details={tracksDetails} tracks={pickedRows} />
			{:else}
				{#snippet songDetails()}
					{song.artist || 'Unknown artist'}{songFile ? ` · ${formatSize(songFile.size)}` : ''}
				{/snippet}
				{@render trackCard(song.title || 'Untitled', artwork, songDetails)}
			{/if}

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
								<span class="min-w-0 text-left [overflow-wrap:anywhere]"
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
										'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-2xl border px-3 py-1.5 text-xs font-semibold transition-colors',
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
										<path
											fill="currentColor"
											d="M7 23q-.825 0-1.412-.587T5 21V3q0-.825.588-1.412T7 1h10q.825 0 1.413.588T19 3v18q0 .825-.587 1.413T17 23zm0-5v3h10v-3zm0-2h10V6H7z"
										/>
									</svg>
									<span class="min-w-0 text-left [overflow-wrap:anywhere]">{device.name}</span>
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

			{#if multi && unreadableCount}
				<p class="text-error text-xs">
					{unreadableCount === songs.length
						? "Couldn't read these tracks from this device."
						: `${unreadableCount} of these tracks can't be read from this device and won't be sent.`}
				</p>
			{:else if !multi && songFile === null}
				<p class="text-error text-xs">Couldn't read "{song.title}" from this device.</p>
			{:else if sendError}
				<p class="text-error text-xs">{sendError}</p>
			{/if}
		</div>
	{/if}

	{#snippet buttons()}
		{#if batchIn}
			{@const id = batchIn.id}
			{#if batchIn.status === 'pending' || batchIn.status === 'answering'}
				{@const busy = batchIn.status === 'answering'}
				<Button variant="text" disabled={busy} onclick={() => declineBatch(id)}>Decline</Button>
				<Button
					variant="filled"
					disabled={busy}
					onclick={() => acceptBatch(id, { location: saveLocation, onDuplicate: batchDuplicates })}
					>Accept all</Button
				>
			{:else if batchIn.status === 'receiving'}
				<Button variant="text" disabled={batchIn.cancelling} onclick={() => cancelIncomingBatch(id)}
					>{batchIn.cancelling ? 'Canceling…' : 'Cancel'}</Button
				>
			{:else}
				{@const playlistId = batchIn.playlistId}
				{#if playlistId}
					<Button
						variant="tonal"
						onclick={() => openReceivedPlaylist(playlistId)}>Open playlist</Button
					>
				{/if}
				<Button variant={batchIn.status === 'done' ? 'filled' : 'text'} onclick={close}
					>{batchIn.status === 'done' ? 'Done' : 'Close'}</Button
				>
			{/if}
		{:else if showBatchOut && batchOut}
			{#if batchOut.status === 'sending'}
				<Button variant="text" disabled={batchOut.cancelling} onclick={() => cancelOutgoingBatch()}
					>{batchOut.cancelling ? 'Canceling…' : 'Cancel'}</Button
				>
			{:else}
				<Button variant={batchOut.status === 'done' ? 'filled' : 'text'} onclick={close}
					>{batchOut.status === 'done' ? 'Done' : 'Close'}</Button
				>
			{/if}
		{:else if current && !answered}
			{@const id = current.id}
			{@const busy = current.status === 'answering'}
			<Button variant="text" disabled={busy} onclick={() => answerOffer(id, false)}>Decline</Button>
			<Button variant="filled" disabled={busy} onclick={() => answerOffer(id, true)}>Accept</Button>
		{:else if current?.status === 'accepted'}
			{@const id = current.id}
			<!-- Cancel works until the transfer completes; after that the sender has nothing left
			     to cancel, while the receiver can still throw the file away. The other button only
			     works once it completes. Both wait while the server confirms a cancel. -->
			{#if incoming && current.done && current.duplicate}
				<!-- The library already has this track: throw this one away, add it as a second copy,
				     or swap it in for the old one. -->
				{@const busy = current.cancelling}
				<Button variant="text" disabled={busy} onclick={() => cancel(id)}
					>{busy ? 'Discarding…' : 'Discard'}</Button
				>
				<Button
					variant="tonal"
					disabled={busy}
					onclick={() => confirmIncoming(id, { location: saveLocation, onDuplicate: 'keep-both' })}
					>Keep both</Button
				>
				<Button
					variant="filled"
					disabled={busy}
					onclick={() => confirmIncoming(id, { location: saveLocation, onDuplicate: 'replace' })}
					>Replace</Button
				>
			{:else}
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
			{/if}
		{:else if current}
			<Button variant="text" onclick={close}>Close</Button>
		{:else if picking}
			<Button variant="text" onclick={close}>Cancel</Button>
			{#if $isLoggedIn}
				<Button
					variant="filled"
					onclick={sendPicked}
					disabled={!target || !readableCount || sending}
				>
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
			<p class="text-on-surface text-sm font-semibold [overflow-wrap:anywhere]">{title}</p>
			<p class="text-on-surface-variant text-xs [overflow-wrap:anywhere]">{@render details()}</p>
		</div>
	</div>
{/snippet}
