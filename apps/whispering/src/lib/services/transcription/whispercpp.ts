import {
	WhisperingErr,
	type WhisperingError,
} from '$lib/result';
import type { Settings } from '$lib/settings';
import { Ok, tryAsync, type Result } from 'wellcrafted/result';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { extractErrorMessage } from 'wellcrafted/error';
import { type } from 'arktype';

const WhisperCppErrorType = type({
	name: "'AudioReadError' | 'GpuError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

export function createWhisperCppTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				outputLanguage: Settings['transcription.outputLanguage'];
				modelPath: string;
			},
		): Promise<Result<string, WhisperingError>> {
			// Pre-validation
			if (!options.modelPath) {
				return WhisperingErr({
					title: '📁 Model File Required',
					description: 'Please select a Whisper model file in settings.',
					action: {
						type: 'link',
						label: 'Configure model',
						href: '/settings/transcription',
					},
				});
			}

			// Check if model file exists
			const { data: isExists } = await tryAsync({
				try: () => exists(options.modelPath),
				catch: () => Ok(false),
			});

			if (!isExists) {
				return WhisperingErr({
					title: '❌ Model File Not Found',
					description: `The model file "${options.modelPath}" does not exist.`,
					action: {
						type: 'link',
						label: 'Select model',
						href: '/settings/transcription',
					},
				});
			}


			// Convert audio blob to byte array
			const arrayBuffer = await audioBlob.arrayBuffer();
			const audioData = Array.from(new Uint8Array(arrayBuffer));

			// Call Tauri command to transcribe with whisper-cpp
			// Note: temperature and prompt are not supported by local models (transcribe-rs)
			const result = await tryAsync({
				try: () =>
					invoke<string>('transcribe_audio_whisper', {
						audioData: audioData,
						modelPath: options.modelPath,
						language:
							options.outputLanguage === 'auto' ? null : options.outputLanguage,
					}),
				catch: (unknownError) => {
					const result = WhisperCppErrorType(unknownError);
					if (result instanceof type.errors) {
						return WhisperingErr({
							title: '❌ Unexpected Whisper C++ Error',
							description: extractErrorMessage(unknownError),
							action: { type: 'more-details', error: unknownError },
						});
					}
					const error = result;
					switch (error.name) {
						case 'ModelLoadError':
							return WhisperingErr({
								title: '🤖 Model Loading Error',
								description: error.message,
								action: {
									type: 'more-details',
									error: new Error(error.message),
								},
							});

						case 'GpuError':
							return WhisperingErr({
								title: '🎮 GPU Error',
								description: error.message,
								action: {
									type: 'link',
									label: 'Configure settings',
									href: '/settings/transcription',
								},
							});

						case 'AudioReadError':
							return WhisperingErr({
								title: '🔊 Audio Read Error',
								description: error.message,
								action: {
									type: 'more-details',
									error: new Error(error.message),
								},
							});

						case 'TranscriptionError':
							return WhisperingErr({
								title: '❌ Transcription Error',
								description: error.message,
								action: {
									type: 'more-details',
									error: new Error(error.message),
								},
							});

						default:
							return WhisperingErr({
								title: '❌ Whisper C++ Error',
								description: 'An unexpected error occurred.',
								action: {
									type: 'more-details',
									error: new Error(String(error)),
								},
							});
					}
				},
			});

			return result;
		},
	};
}

export type WhisperCppTranscriptionService = ReturnType<
	typeof createWhisperCppTranscriptionService
>;

export const WhisperCppTranscriptionServiceLive =
	createWhisperCppTranscriptionService();
