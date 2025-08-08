import { WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS } from '$lib/constants/audio';
import { createTaggedError } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type {
	DeviceIdentifier,
	DeviceAcquisitionOutcome,
	UpdateStatusMessageFn,
} from './types';
import { asDeviceIdentifier } from './types';

const { DeviceStreamServiceError, DeviceStreamServiceErr } = createTaggedError(
	'DeviceStreamServiceError',
);
type DeviceStreamServiceError = ReturnType<typeof DeviceStreamServiceError>;

export async function hasExistingAudioPermission(): Promise<boolean> {
	try {
		const permissions = await navigator.permissions.query({
			name: 'microphone',
		});
		return permissions.state === 'granted';
	} catch {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
			});
			for (const track of stream.getTracks()) {
				track.stop();
			}
			return true;
		} catch {
			return false;
		}
	}
}

export async function enumerateRecordingDeviceIds(): Promise<
	Result<DeviceIdentifier[], DeviceStreamServiceError>
> {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperingTab({});
	}
	return tryAsync({
		try: async () => {
			const allAudioDevicesStream = await navigator.mediaDevices.getUserMedia({
				audio: WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
			});
			const devices = await navigator.mediaDevices.enumerateDevices();
			for (const track of allAudioDevicesStream.getTracks()) {
				track.stop();
			}
			const audioInputDevices = devices.filter(
				(device) => device.kind === 'audioinput',
			);
			// On Web: Return deviceIds as identifiers (NOT labels)
			return audioInputDevices.map((device) =>
				asDeviceIdentifier(device.deviceId),
			);
		},
		mapErr: (error) =>
			DeviceStreamServiceErr({
				message:
					'We need permission to see your microphones. Check your browser settings and try again.',
				context: { permissionRequired: 'microphone' },
				cause: error,
			}),
	});
}

/**
 * Get a media stream for a specific device identifier
 * @param deviceIdentifier - The device identifier
 *   - On Web: This is the deviceId (unique identifier)
 *   - On Desktop: This is the device name
 */
async function getStreamForDeviceIdentifier(
	deviceIdentifier: DeviceIdentifier,
) {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperingTab({});
	}
	return tryAsync({
		try: async () => {
			// On Web: deviceIdentifier IS the deviceId, use it directly
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					...WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
					deviceId: { exact: deviceIdentifier },
				},
			});
			return stream;
		},
		mapErr: (error) =>
			DeviceStreamServiceErr({
				message:
					'Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions. Please check that your microphone is connected, not being used elsewhere, and that you have granted microphone permissions.',
				context: {
					deviceIdentifier,
					hasPermission,
				},
				cause: error,
			}),
	});
}

export async function getRecordingStream(
	selectedDeviceId: DeviceIdentifier | null,
	sendStatus: UpdateStatusMessageFn,
): Promise<
	Result<
		{ stream: MediaStream; deviceOutcome: DeviceAcquisitionOutcome },
		DeviceStreamServiceError
	>
> {
	// Try preferred device first if specified
	if (!selectedDeviceId) {
		// No device selected
		sendStatus({
			title: '🔍 No Device Selected',
			description:
				"No worries! We'll find the best microphone for you automatically...",
		});
	} else {
		sendStatus({
			title: '🎯 Connecting Device',
			description:
				'Almost there! Just need your permission to use the microphone...',
		});

		const { data: preferredStream, error: getPreferredStreamError } =
			await getStreamForDeviceIdentifier(selectedDeviceId);

		if (!getPreferredStreamError) {
			return Ok({
				stream: preferredStream,
				deviceOutcome: { outcome: 'success' },
			});
		}

		// We reach here if the preferred device failed, so we'll fall back to the first available device
		sendStatus({
			title: '⚠️ Finding a New Microphone',
			description:
				"That microphone isn't working. Let's try finding another one...",
		});
	}

	// Try to get any available device as fallback
	const getFirstAvailableStream = async (): Promise<
		Result<
			{ stream: MediaStream; deviceId: DeviceIdentifier },
			DeviceStreamServiceError
		>
	> => {
		const { data: recordingDeviceIds, error: enumerateDevicesError } =
			await enumerateRecordingDeviceIds();
		if (enumerateDevicesError)
			return DeviceStreamServiceErr({
				message:
					'Error enumerating recording devices and acquiring first available stream. Please make sure you have given permission to access your audio devices',
				cause: enumerateDevicesError,
			});

		for (const deviceId of recordingDeviceIds) {
			const { data: stream, error } =
				await getStreamForDeviceIdentifier(deviceId);
			if (!error) {
				return Ok({ stream, deviceId });
			}
		}

		return DeviceStreamServiceErr({
			message: 'Unable to connect to any available microphone',
			context: { recordingDeviceIds },
			cause: undefined,
		});
	};

	// Get fallback stream
	const { data: fallbackStreamData, error: getFallbackStreamError } =
		await getFirstAvailableStream();
	if (getFallbackStreamError) {
		const errorMessage = selectedDeviceId
			? "We couldn't connect to any microphones. Make sure they're plugged in and try again!"
			: "Hmm... We couldn't find any microphones to use. Check your connections and try again!";
		return DeviceStreamServiceErr({
			message: errorMessage,
			context: { selectedDeviceId },
			cause: getFallbackStreamError,
		});
	}


	// Return the stream with appropriate device outcome
	if (!selectedDeviceId) {
		return Ok({
			stream: fallbackStreamData.stream,
			deviceOutcome: {
				outcome: 'fallback',
				reason: 'no-device-selected',
				fallbackDevice: fallbackStreamData.deviceId,
			},
		});
	}
	return Ok({
		stream: fallbackStreamData.stream,
		deviceOutcome: {
			outcome: 'fallback',
			reason: 'preferred-device-unavailable',
			fallbackDevice: fallbackStreamData.deviceId,
		},
	});
}

export function cleanupRecordingStream(stream: MediaStream) {
	for (const track of stream.getTracks()) {
		track.stop();
	}
}
