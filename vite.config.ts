import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import type { ManifestOptions } from 'vite-plugin-pwa';
import { sitemapPlugin } from 'sveltekit-sitemap/dist/plugin.js';
import rawManifest from './static/manifest.json';

const manifest = rawManifest as Partial<ManifestOptions>;

export default defineConfig(({ mode }) => {
	const isDevelopment = mode === 'development';
	return {
		resolve: {
			dedupe: ['svelte', 'zod']
		},
		plugins: [
			sveltekit(),
			// Disable PWA in dev to avoid SW interfering with HMR
			!isDevelopment &&
				SvelteKitPWA({
					registerType: 'prompt',
					injectRegister: false,
					manifest,
					workbox: {
						navigateFallback: null,
						globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,gif,webp,woff,woff2,ttf,eot}'],
						runtimeCaching: [
							{
								urlPattern: ({ request, url }) =>
									request.mode === 'navigate' &&
									url.origin === self.location.origin &&
									!url.searchParams.has('token'),
								handler: 'NetworkFirst',
								options: {
									cacheName: 'api-cache',
									networkTimeoutSeconds: 10,
									matchOptions: { ignoreSearch: true },
									cacheableResponse: { statuses: [0, 200] }
								}
							}
						]
					},
					devOptions: { enabled: false }
				}),
			!isDevelopment &&
				sitemapPlugin({
					routesDir: './src/routes',
					sitemapFile: './src/sitemap.ts'
				}),
			!isDevelopment && devtoolsJson()
		].filter(Boolean),
		optimizeDeps: {
			exclude: ['svelte']
		},
		server: {
			// IPv4 only. On Windows "localhost" otherwise binds to ::1, and Firefox can't gather
			// WebRTC candidates on a page loaded over IPv6 loopback, so device transfers fail there.
			// `npm run dev -- --host` still overrides this for testing from other devices.
			host: '127.0.0.1',
			watch: {
				usePolling: true
			}
		}
	};
});
