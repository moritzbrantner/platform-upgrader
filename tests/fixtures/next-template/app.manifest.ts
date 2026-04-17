export const appManifest = {
  appId: 'web',
  slug: 'web',
  displayName: 'Web',
  platform: 'web',
  packageName: 'next-template',
  entryWorkspace: 'apps/web',
  releaseCadence: 'independent',
  deployment: {
    runtime: 'nextjs',
  },
} as const;
