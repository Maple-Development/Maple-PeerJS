<script lang="ts">
	import { isLoggedIn } from '$lib/store';
	import { socket } from '$lib/store';
	import { devices, selfDeviceId } from '$lib/devices';
	import type { OwnDevice } from '$shared/types/peer';
	import { Dialog, Button } from 'm3-svelte';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	const MAX_NAME = 40;

	let {
		visible = $bindable(false),
		onSelect
	}: {
		visible?: boolean;
		onSelect?: (device: OwnDevice) => void;
	} = $props();

	let editingId = $state<string | null>(null);
	let draftName = $state('');
	let selfId = $state('');

	// Registration lives in socketManager (via $lib/devices), so every logged-in tab shows up
	// even on pages without track cards. This component only displays the list.
	onMount(() => {
		selfId = selfDeviceId();
	});

	let sortedDevices = $derived(
		[...$devices].sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId))
	);

	$effect(() => {
		if (!visible) editingId = null;
	});

	function select(device: OwnDevice) {
		if (editingId) return;
		onSelect?.(device);
		visible = false;
	}

	function startEdit(device: OwnDevice) {
		editingId = device.id;
		draftName = device.name;
	}

	function saveEdit() {
		const name = draftName.trim();
		if (editingId && name && name.length <= MAX_NAME) {
			$socket?.emit('peer:rename', editingId, name);
		}
		editingId = null;
	}

	function onEditKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveEdit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			editingId = null;
		}
	}

	function focusAndSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<Dialog headline="Send to device" bind:open={visible} closeOnEsc={editingId === null}>
	{#snippet buttons()}
		<Button variant="text" onclick={() => (visible = false)}>Cancel</Button>
		{#if !$isLoggedIn}
			<Button
				variant="filled"
				onclick={() => {
					visible = false;
					goto('/login');
				}}>Sign in</Button
			>
		{/if}
	{/snippet}

	{#if !$isLoggedIn}
		<p class="text-on-surface-variant min-w-72 text-sm">
			Sign in to send tracks to your other devices.
		</p>
	{:else}
		<div class="-mx-2 flex min-w-72 flex-col gap-1">
			{#each sortedDevices as device (device.id)}
				{@const isSelf = device.id === selfId}
				<div
					class="group flex items-center gap-1 rounded-2xl transition-colors duration-150 {isSelf ||
					editingId === device.id
						? ''
						: 'hover:bg-surface-container-high'}"
				>
					{#if editingId === device.id}
						<div class="flex flex-1 items-center gap-3 py-2 pl-3">
							{@render deviceIcon(isSelf)}
							<input
								use:focusAndSelect
								bind:value={draftName}
								onkeydown={onEditKeydown}
								maxlength={MAX_NAME}
								aria-label="Device name"
								class="text-on-surface border-outline focus:border-primary bg-surface-container-highest min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
							/>
						</div>
						<button
							onclick={saveEdit}
							disabled={!draftName.trim()}
							aria-label="Save name"
							title="Save"
							class="text-primary hover:bg-surface-container-highest rounded-full p-2 transition-colors disabled:opacity-40"
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
								<path
									fill="currentColor"
									d="m9.55 18l-5.7-5.7l1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4z"
								/>
							</svg>
						</button>
						<button
							onclick={() => (editingId = null)}
							aria-label="Cancel rename"
							title="Cancel"
							class="text-on-surface-variant hover:bg-surface-container-highest mr-1 rounded-full p-2 transition-colors"
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
								<path
									fill="currentColor"
									d="M6.4 19L5 17.6l5.6-5.6L5 6.4L6.4 5l5.6 5.6L17.6 5L19 6.4L13.4 12l5.6 5.6l-1.4 1.4l-5.6-5.6z"
								/>
							</svg>
						</button>
					{:else}
						<button
							onclick={() => select(device)}
							disabled={isSelf}
							class="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pl-3 text-left disabled:cursor-default"
						>
							{@render deviceIcon(isSelf)}
							<div class="flex min-w-0 flex-col">
								<span class="text-on-surface truncate text-base font-medium" title={device.name}>
									{device.name}
								</span>
								<span class="text-on-surface-variant text-xs">
									{isSelf ? 'This device' : 'Tap to send'}
								</span>
							</div>
						</button>
						<button
							onclick={() => startEdit(device)}
							aria-label="Rename {device.name}"
							title="Rename"
							class="text-on-surface-variant hover:bg-surface-container-highest mr-1 rounded-full p-2 opacity-60 transition group-hover:opacity-100 focus-visible:opacity-100"
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
								<path
									fill="currentColor"
									d="M5 19h1.425L16.2 9.225L14.775 7.8L5 17.575zm-2 2v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.438.65T21 6.4q0 .4-.137.763t-.438.662L7.25 21zM19 6.4L17.6 5zm-3.525 2.125l-.7-.725L16.2 9.225z"
								/>
							</svg>
						</button>
					{/if}
				</div>
			{:else}
				<p class="text-on-surface-variant px-3 py-6 text-center text-sm">Not connected.</p>
			{/each}
			{#if sortedDevices.length > 0 && sortedDevices.every((d) => d.id === selfId)}
				<p class="text-on-surface-variant px-3 pt-2 pb-1 text-sm">
					No other devices are online. Open Maple on another device signed in to this account.
				</p>
			{/if}
		</div>
	{/if}
</Dialog>

{#snippet deviceIcon(isSelf: boolean)}
	<div
		class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full {isSelf
			? 'bg-surface-container-highest text-on-surface-variant'
			: 'bg-primary-container text-on-primary-container'}"
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
			<path
				fill="currentColor"
				d="M2 21q-.425 0-.712-.288T1 20t.288-.712T2 19h20q.425 0 .713.288T23 20t-.288.713T22 21zm2-3q-.825 0-1.412-.587T2 16V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v11q0 .825-.587 1.413T20 18zm0-2h16V5H4zm0 0V5z"
			/>
		</svg>
	</div>
{/snippet}
