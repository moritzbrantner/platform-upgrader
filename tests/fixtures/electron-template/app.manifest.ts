export const appManifest = {
  appId: 'desktop',
  slug: 'desktop',
  displayName: 'Desktop',
  platform: 'desktop',
  packageName: 'desktop',
  entryWorkspace: 'apps/desktop',
  releaseCadence: 'independent',
  sharedPackages: [],
  deployment: {
    runtime: 'electron',
  },
} as const;
