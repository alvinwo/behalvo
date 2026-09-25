import { isAbsolute, resolve } from 'node:path';

export const NATIVE_HOST_NAME = 'com.behalvo.synthetic_browser';
/** Task 7 deliberately ships no live visa native-host registration. */
export const LIVE_US_VISA_NATIVE_HOST_REGISTRATION = null;

export interface NativeHostManifest {
  name: typeof NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: [string];
}

export function createNativeHostManifest(input: { executablePath: string; extensionId: string }): NativeHostManifest {
  if (!input || typeof input.executablePath !== 'string' || !isAbsolute(input.executablePath) ||
      typeof input.extensionId !== 'string' || !/^[a-p]{32}$/.test(input.extensionId))
    throw new Error('Invalid native host manifest configuration.');
  const path = resolve(input.executablePath);
  return { name: NATIVE_HOST_NAME, description: 'Behalvo local synthetic browser boundary', path,
    type: 'stdio', allowed_origins: [`chrome-extension://${input.extensionId}/`] };
}
