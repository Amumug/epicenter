import { type } from 'arktype';
import { createApps, createAppUrls } from '#apps';

/**
 * Vite/client-side constants and utilities
 * Uses import.meta.env.MODE for environment detection
 */

// Schema
const viteEnvSchema = type({
	MODE: "'development' | 'production'",
});

export function validateViteEnv(env: unknown): ViteEnv {
	const result = viteEnvSchema(env);
	if (result instanceof type.errors) throw new Error(result.summary);
	return result;
}

export type ViteEnv = typeof viteEnvSchema.infer;

/**
 * Vite build-time URLs.
 * Uses import.meta.env.MODE for environment detection.
 * 
 * For use in Vite contexts (client-side applications).
 */
export const APPS = createApps(import.meta.env.MODE);

/**
 * All application URLs for Vite contexts.
 * Uses import.meta.env.MODE for environment detection.
 * 
 * Primarily used for CORS configuration in client-side applications.
 */
export const APP_URLS = createAppUrls(import.meta.env.MODE);