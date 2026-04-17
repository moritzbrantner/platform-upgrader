export const appManifest = {
  appId: 'mobile',
  slug: 'mobile',
  displayName: 'Mobile',
  platform: 'mobile',
  packageName: 'mobile',
  releaseCadence: 'independent',
  featureFlags: ['auth'],
  deployment: {
    runtime: 'expo',
  },
} as const;
