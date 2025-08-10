import type { CancelRecordingResult } from '$lib/constants/audio';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { DeviceAcquisitionOutcome, DeviceIdentifier } from '../types';
import { asDeviceIdentifier } from '../types';
import type {
	RecorderService,
	RecorderServiceError,
	StartRecordingParams,
} from './types';
import { RecorderServiceErr } from './types';

export function createDesktopRecorderService(): RecorderService {
	const enumerateRecordingDeviceIds = async (): Promise<
		Result<DeviceIdentifier[], RecorderServiceError>
	> => {
		const { data: deviceNames, error: enumerateRecordingDevicesError } =
			await invoke<string[]>('enumerate_recording_devices');
		if (enumerateRecordingDevicesError) {
			return RecorderServiceErr({
				message: 'Failed to enumerate recording devices',
				cause: enumerateRecordingDevicesError,
			});
		}
		// Device names are the identifiers for desktop recording
		return Ok(deviceNames.map(asDeviceIdentifier));
	};

	return {
		getCurrentRecordingId: async (): Promise<
			Result<string | null, RecorderServiceError>
		> => {
			const { data: recordingId, error: getCurrentRecordingIdError } =
				await invoke<string | null>('get_current_recording_id');
			if (getCurrentRecordingIdError)
				return RecorderServiceErr({
					message:
						'We encountered an issue while getting the current recording. This could be because your microphone is being used by another app, your microphone permissions are denied, or the selected recording device is disconnected',
					context: { error: getCurrentRecordingIdError },
					cause: getCurrentRecordingIdError,
				});

			return Ok(recordingId);
		},

		enumerateRecordingDeviceIds,

		startRecording: async (
			params: StartRecordingParams,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
			// Desktop implementation only handles desktop params
			if (params.platform !== 'desktop') {
				return RecorderServiceErr({
					message: 'Desktop recorder received non-desktop parameters',
					context: { params },
					cause: undefined,
				});
			}

			const { selectedDeviceId, recordingId, outputFolder, sampleRate } =
				params;
			const { data: deviceIds, error: enumerateError } =
				await enumerateRecordingDeviceIds();
			if (enumerateError) return Err(enumerateError);

			const acquireDevice = (): Result<
				DeviceAcquisitionOutcome,
				RecorderServiceError
			> => {
				const fallbackDeviceId = deviceIds.at(0);
				if (!fallbackDeviceId) {
					return RecorderServiceErr({
						message: selectedDeviceId
							? "We couldn't find the selected microphone. Make sure it's connected and try again!"
							: "We couldn't find any microphones. Make sure they're connected and try again!",
						context: { selectedDeviceId, deviceIds },
						cause: undefined,
					});
				}

				if (!selectedDeviceId) {
					sendStatus({
						title: '🔍 No Device Selected',
						description:
							"No worries! We'll find the best microphone for you automatically...",
					});
					return Ok({
						outcome: 'fallback',
						reason: 'no-device-selected',
						fallbackDeviceId,
					});
				}

				// Check if the selected device exists in the devices array
				const deviceExists = deviceIds.includes(selectedDeviceId);

				if (deviceExists) return Ok({ outcome: 'success' });

				sendStatus({
					title: '⚠️ Finding a New Microphone',
					description:
						"That microphone isn't available. Let's try finding another one...",
				});

				return Ok({
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					fallbackDeviceId,
				});
			};

			const { data: deviceOutcome, error: acquireDeviceError } =
				acquireDevice();
			if (acquireDeviceError) return Err(acquireDeviceError);

			// Determine which device name to use based on the outcome
			const deviceIdentifier =
				deviceOutcome.outcome === 'success'
					? selectedDeviceId
					: deviceOutcome.fallbackDeviceId;

			// Now initialize recording with the chosen device
			sendStatus({
				title: '🎤 Setting Up',
				description:
					'Initializing your recording session and checking microphone access...',
			});

			// Convert sample rate string to number if provided
			const sampleRateNum = sampleRate
				? Number.parseInt(sampleRate, 10)
				: undefined;

			const { error: initRecordingSessionError } = await invoke(
				'init_recording_session',
				{
					deviceIdentifier,
					recordingId,
					outputFolder: outputFolder || undefined,
					sampleRate: sampleRateNum,
				},
			);
			if (initRecordingSessionError)
				return RecorderServiceErr({
					message:
						'We encountered an issue while setting up your recording session. This could be because your microphone is being used by another app, your microphone permissions are denied, or the selected recording device is disconnected',
					context: {
						selectedDeviceId,
						deviceIdentifier,
					},
					cause: initRecordingSessionError,
				});

			sendStatus({
				title: '🎙️ Starting Recording',
				description:
					'Recording session initialized, now starting to capture audio...',
			});
			const { error: startRecordingError } =
				await invoke<void>('start_recording');
			if (startRecordingError)
				return RecorderServiceErr({
					message:
						'Unable to start recording. Please check your microphone and try again.',
					context: { deviceIdentifier, deviceOutcome },
					cause: startRecordingError,
				});

			return Ok(deviceOutcome);
		},

		stopRecording: async ({
			sendStatus,
		}): Promise<Result<Blob, RecorderServiceError>> => {
			const { data: audioRecording, error: stopRecordingError } = await invoke<{
				audioData: number[];
				sampleRate: number;
				channels: number;
				durationSeconds: number;
				filePath?: string;
			}>('stop_recording');
			if (stopRecordingError) {
				return RecorderServiceErr({
					message: 'Unable to save your recording. Please try again.',
					context: { operation: 'stopRecording' },
					cause: stopRecordingError,
				});
			}

			let blob: Blob;

			// Check if we have a file path (new file-based recording) or audio data (legacy)
			if (audioRecording.filePath) {
				// Read the WAV file from disk using Tauri FS plugin
				sendStatus({
					title: '📁 Reading Recording',
					description: 'Loading your recording from disk...',
				});

				try {
					const { readFile } = await import('@tauri-apps/plugin-fs');
					const fileBytes = await readFile(audioRecording.filePath);
					blob = new Blob([fileBytes], { type: 'audio/wav' });
				} catch (error) {
					return RecorderServiceErr({
						message: 'Unable to read recording file. Please try again.',
						context: {
							operation: 'readRecordingFile',
							filePath: audioRecording.filePath,
						},
						cause: error,
					});
				}
			} else {
				// Legacy: create WAV from float32 array
				const float32Array = new Float32Array(audioRecording.audioData);
				blob = createWavFromFloat32(
					float32Array,
					audioRecording.sampleRate,
					audioRecording.channels,
				);
			}

			// Close the recording session after stopping
			sendStatus({
				title: '🔄 Closing Session',
				description: 'Cleaning up recording resources...',
			});
			const { error: closeError } = await invoke<void>(
				'close_recording_session',
			);
			if (closeError) {
				// Log but don't fail the stop operation
				console.error('Failed to close recording session:', closeError);
			}

			return Ok(blob);
		},

		cancelRecording: async ({
			sendStatus,
		}): Promise<Result<CancelRecordingResult, RecorderServiceError>> => {
			// Check current state first
			const { data: recordingId, error: getRecordingIdError } = await invoke<
				string | null
			>('get_current_recording_id');
			if (getRecordingIdError) {
				return RecorderServiceErr({
					message:
						'Unable to check recording state. Please try closing the app and starting again.',
					context: { operation: 'cancelRecording' },
					cause: getRecordingIdError,
				});
			}

			if (!recordingId) {
				return Ok({ status: 'no-recording' });
			}

			sendStatus({
				title: '🛑 Cancelling',
				description:
					'Safely stopping your recording and cleaning up resources...',
			});

			// First get the recording data to know if there's a file to delete
			const { data: audioRecording } = await invoke<{
				audioData: number[];
				sampleRate: number;
				channels: number;
				durationSeconds: number;
				filePath?: string;
			}>('stop_recording');

			// If there's a file path, delete the file using Tauri FS plugin
			if (audioRecording?.filePath) {
				try {
					const { remove } = await import('@tauri-apps/plugin-fs');
					await remove(audioRecording.filePath);
				} catch (error) {
					console.error('Failed to delete recording file:', error);
				}
			}

			// Close the recording session after cancelling
			sendStatus({
				title: '🔄 Closing Session',
				description: 'Cleaning up recording resources...',
			});
			const { error: closeError } = await invoke<void>(
				'close_recording_session',
			);
			if (closeError) {
				// Log but don't fail the cancel operation
				console.error('Failed to close recording session:', closeError);
			}

			return Ok({ status: 'cancelled' });
		},
	};
}

async function invoke<T>(command: string, args?: Record<string, unknown>) {
	return tryAsync({
		try: async () => await tauriInvoke<T>(command, args),
		mapErr: (error) =>
			Err({ name: 'TauriInvokeError', command, error } as const),
	});
}

function createWavFromFloat32(
	float32Array: Float32Array,
	sampleRate: number,
	numChannels: number,
) {
	// WAV header parameters
	const bitsPerSample = 32;
	const bytesPerSample = bitsPerSample / 8;

	// Calculate sizes
	const dataSize = float32Array.length * bytesPerSample;
	const headerSize = 44; // Standard WAV header size
	const totalSize = headerSize + dataSize;

	// Create the buffer
	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);

	// Write WAV header
	// "RIFF" chunk descriptor
	writeString(view, 0, 'RIFF');
	view.setUint32(4, totalSize - 8, true);
	writeString(view, 8, 'WAVE');

	// "fmt " sub-chunk
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
	view.setUint16(20, 3, true); // AudioFormat (3 for Float)
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
	view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
	view.setUint16(34, bitsPerSample, true);

	// "data" sub-chunk
	writeString(view, 36, 'data');
	view.setUint32(40, dataSize, true);

	// Write audio data
	const dataView = new Float32Array(buffer, headerSize);
	dataView.set(float32Array);

	// Create and return blob
	return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
	for (let i = 0; i < string.length; i++) {
		view.setUint8(offset + i, string.charCodeAt(i));
	}
}

export const DesktopRecorderServiceLive = createDesktopRecorderService();
