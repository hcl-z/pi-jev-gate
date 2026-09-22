/**
 * Configuration resolution.
 *
 * Read defensively: a bad settings file must never cost the user a session, so
 * every failure path falls back to the default rather than surfacing an error.
 */

import type { GuardConfig } from "./types.ts";
import { isRecord } from "./util.ts";

export const DEFAULT_THRESHOLD = 0.6;

/**
 * Pinned rather than the moving `jev-latest` alias: an alias advancing would
 * silently change what a tuned threshold means.
 */
export const DEFAULT_MODEL = "jev-1.13.0";

export const API_KEY_ENV = "TYPESAFE_API_KEY";

export function resolveConfig(
	settingsText: string | undefined,
	env: (name: string) => string | undefined,
): GuardConfig {
	const block = readGuardBlock(settingsText);

	const envKey = nonEmptyString(env(API_KEY_ENV));
	const configKey = nonEmptyString(block.apiKey);

	return {
		// The environment wins, so CI and one-off runs override without an edit.
		apiKey: envKey ?? configKey,
		threshold: validThreshold(block.threshold) ?? DEFAULT_THRESHOLD,
		model: nonEmptyString(block.model) ?? DEFAULT_MODEL,
		log: block.log === true,
	};
}

function readGuardBlock(settingsText: string | undefined): {
	apiKey?: unknown;
	threshold?: unknown;
	model?: unknown;
	log?: unknown;
} {
	if (settingsText === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(settingsText));
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const block = parsed.jevGate;
	if (!isRecord(block)) return {};
	return block;
}

function validThreshold(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value)) return undefined;
	if (value < 0 || value > 1) return undefined;
	return value;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
