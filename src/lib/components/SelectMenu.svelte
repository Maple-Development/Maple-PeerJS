<script lang="ts">
	import { Menu, MenuItem } from 'm3-svelte';
	import { tick } from 'svelte';

	/**
	 * A dropdown built from m3-svelte's Menu and MenuItem: a button showing the chosen option that
	 * opens a menu of all of them, the chosen one checked. The menu is a popover, so it shows above
	 * dialogs and isn't clipped by them.
	 */
	let {
		options,
		value = $bindable(),
		onchange,
		disabled = false,
		id,
		label,
		describedby,
		size = 'md',
		class: className = ''
	}: {
		options: { id: string; name: string }[];
		value: string;
		onchange?: (value: string) => void;
		disabled?: boolean;
		id?: string;
		/** Accessible name, when no <label for={id}> names the button. */
		label?: string;
		describedby?: string;
		/** sm: compact, for dialogs. md: matches the settings page's other fields. */
		size?: 'sm' | 'md';
		class?: string;
	} = $props();

	let trigger: HTMLButtonElement | undefined = $state();
	let popover: HTMLDivElement | undefined = $state();
	let open = $state(false);
	let position = $state({ top: 0, left: 0, width: 0 });

	let selected = $derived(options.find((o) => o.id === value));
	const menuId = $props.id();

	function place() {
		if (!trigger || !popover) return;
		const rect = trigger.getBoundingClientRect();
		const height = popover.offsetHeight;
		// Below the button, or above it when there isn't room underneath.
		const below = rect.bottom + 4;
		const top =
			below + height > window.innerHeight && rect.top - 4 - height > 0
				? rect.top - 4 - height
				: below;
		position = { top, left: rect.left, width: rect.width };
	}

	function show() {
		if (!disabled && !popover?.matches(':popover-open')) popover?.showPopover();
	}

	async function onToggle(e: ToggleEvent) {
		open = e.newState === 'open';
		if (!open) return;
		place();
		await tick();
		focusItem(Math.max(0, options.findIndex((o) => o.id === value)));
	}

	function hide(refocus = true) {
		if (popover?.matches(':popover-open')) popover.hidePopover();
		if (refocus) trigger?.focus();
	}

	function choose(id: string) {
		hide();
		if (id === value) return;
		value = id;
		onchange?.(id);
	}

	function items(): HTMLButtonElement[] {
		return popover ? [...popover.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
	}

	function focusItem(index: number) {
		const list = items();
		list[(index + list.length) % list.length]?.focus();
	}

	function onMenuKeydown(e: KeyboardEvent) {
		const list = items();
		const current = list.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown') focusItem(current + 1);
		else if (e.key === 'ArrowUp') focusItem(current - 1);
		else if (e.key === 'Home') focusItem(0);
		else if (e.key === 'End') focusItem(list.length - 1);
		// Handled here too: a dialog underneath may block the browser's own Esc handling.
		else if (e.key === 'Escape') hide();
		else if (e.key === 'Tab') hide(false);
		else return;
		e.preventDefault();
		e.stopPropagation();
	}

	function onTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			show();
		}
	}

	// Arrow keys move between options. Attached here rather than as an attribute: the items are
	// m3-svelte's plain buttons, so the container can't take a menu role.
	$effect(() => {
		const menu = popover;
		if (!menu) return;
		menu.addEventListener('keydown', onMenuKeydown);
		return () => menu.removeEventListener('keydown', onMenuKeydown);
	});

	// Keep the menu next to its button while the page scrolls or resizes.
	$effect(() => {
		if (!open) return;
		const update = () => place();
		window.addEventListener('scroll', update, true);
		window.addEventListener('resize', update);
		return () => {
			window.removeEventListener('scroll', update, true);
			window.removeEventListener('resize', update);
		};
	});
</script>

<button
	bind:this={trigger}
	type="button"
	{id}
	{disabled}
	aria-label={label}
	aria-describedby={describedby}
	aria-expanded={open}
	aria-controls={menuId}
	popovertarget={menuId}
	onkeydown={onTriggerKeydown}
	class={[
		'text-on-surface flex min-w-0 cursor-pointer items-center justify-between gap-2 text-left transition disabled:cursor-default disabled:opacity-60',
		size === 'sm'
			? 'bg-surface-container-highest border-outline rounded-lg border px-2.5 py-1 text-xs'
			: 'bg-surface ring-outline-variant rounded-xl px-3.5 py-2.5 text-sm ring-1',
		open && (size === 'sm' ? 'border-primary' : 'ring-primary ring-2'),
		className
	]}
>
	<span class="truncate">{selected?.name ?? ''}</span>
	<svg
		class={['shrink-0 transition-transform', open && 'rotate-180']}
		width={size === 'sm' ? 16 : 20}
		height={size === 'sm' ? 16 : 20}
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path fill="currentColor" d="m7 10l5 5l5-5z" />
	</svg>
</button>

<div
	bind:this={popover}
	id={menuId}
	popover="auto"
	onbeforetoggle={(e) => (e as ToggleEvent).newState === 'open' && place()}
	ontoggle={(e) => onToggle(e as ToggleEvent)}
	class="m-0 overflow-visible border-0 bg-transparent p-0"
	style:position="fixed"
	style:inset="auto"
	style:top="{position.top}px"
	style:left="{position.left}px"
	style:min-width="{position.width}px"
>
	<Menu>
		<div class="flex max-h-72 flex-col overflow-y-auto">
			{#each options as option (option.id)}
				{@const active = option.id === value}
				<MenuItem click={() => choose(option.id)}>
					<span class={['min-w-0 flex-1 truncate', active && 'text-primary font-semibold']}
						>{option.name}{#if active}<span class="sr-only"> (selected)</span>{/if}</span
					>
					{#if active}
						<svg
							class="text-primary ml-3 shrink-0"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path fill="currentColor" d="M9.55 18L3.85 12.3l1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4z" />
						</svg>
					{/if}
				</MenuItem>
			{/each}
		</div>
	</Menu>
</div>
