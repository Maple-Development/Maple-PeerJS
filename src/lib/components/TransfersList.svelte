<script lang="ts">
	import {
		clearTransferHistory,
		transferHistory,
		type FinishedTransfer,
		type TransferOutcome
	} from '$lib/devices';

	/**
	 * The Transfers tab on the Social page: transfers that ended this session. Anything still
	 * going (offers, sending, receiving, waiting to be imported) is handled in the transfer popup
	 * (TransferDialog.svelte) and only shows up here once it's over.
	 */

	/**
	 * Each section lists the transfers that ended one of these ways. Declined covers every way
	 * the track was turned away without anyone stopping a transfer under way.
	 */
	const SECTIONS: { title: string; outcomes: TransferOutcome[] }[] = [
		{ title: 'Completed', outcomes: ['sent', 'imported'] },
		{ title: 'Declined', outcomes: ['declined', 'expired', 'discarded'] },
		{ title: 'Canceled', outcomes: ['cancelled'] },
		{ title: 'Failed', outcomes: ['failed'] }
	];

	let sections = $derived(
		SECTIONS.map((section) => ({
			...section,
			entries: $transferHistory.filter((entry) => section.outcomes.includes(entry.outcome))
		})).filter((section) => section.entries.length > 0)
	);

	/** What happened, in a few words. */
	function outcomeText(entry: FinishedTransfer) {
		if (entry.detail) return entry.detail.replace(/\.$/, '');
		const incoming = entry.direction === 'in';
		switch (entry.outcome) {
			case 'sent':
				return 'Delivered & verified';
			case 'imported':
				return 'Imported to local library';
			case 'discarded':
				return 'Discarded';
			case 'declined':
				return incoming ? 'You declined it' : `${entry.peer} declined it`;
			case 'expired':
				return 'Nobody answered in time';
			default:
				return '';
		}
	}

	function timeOf(ms: number) {
		return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}
</script>

{#if $transferHistory.length === 0}
	<div class="flex flex-col items-center justify-center py-16 text-center">
		<div
			class="bg-surface-container text-on-surface-variant mb-4 flex h-14 w-14 items-center justify-center rounded-full"
			aria-hidden="true"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24">
				<path fill="currentColor" d="M3 20v-6l8-2l-8-2V4l19 8z" />
			</svg>
		</div>
		<p class="text-on-surface text-lg font-bold">No transfers</p>
		<p class="text-on-surface-variant mt-1 max-w-xs text-sm">
			To send a track to another of your devices, open its menu and choose Send to Device.
		</p>
	</div>
{:else}
	<!-- Ended this session (kept in memory until reload or Clear) -->
	<div class="flex flex-col gap-6">
		{#each sections as section, i (section.title)}
			<section aria-label="{section.title} transfers" class="flex flex-col gap-3">
				<div class="flex items-center justify-between">
					<h2 class="text-on-surface-variant text-sm font-semibold">{section.title}</h2>
					<!-- One Clear for the whole list, beside the first heading. -->
					{#if i === 0}
						<button
							type="button"
							onclick={clearTransferHistory}
							class="text-on-surface-variant hover:text-on-surface cursor-pointer border-none bg-transparent text-xs font-medium transition-colors"
						>
							Clear
						</button>
					{/if}
				</div>
				<div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
					{#each section.entries as entry (entry.id)}
						{@const text = outcomeText(entry)}
						<div class="bg-surface-container-low min-w-0 rounded-2xl px-4 py-3 opacity-80">
							<p class="text-on-surface text-sm font-semibold wrap-anywhere">
								{entry.title}
							</p>
							<p
								class={[
									'mt-0.5 text-xs wrap-anywhere',
									entry.outcome === 'failed' ? 'text-error' : 'text-on-surface-variant'
								]}
							>
								{entry.peer}{text ? ` · ${text}` : ''} · {timeOf(entry.endedAt)}
							</p>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}
