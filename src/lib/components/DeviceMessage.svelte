<script lang="ts">
	/**
	 * Text that names a device, with the name in bold so it reads as a device.
	 * Also used as a toast title (via componentProps), since toasts only take plain strings.
	 */
	let {
		device,
		before = '',
		after = ''
	}: {
		device: string;
		before?: string;
		after?: string;
	} = $props();
</script>

{before}<strong class="font-bold">{device}</strong>{after}
