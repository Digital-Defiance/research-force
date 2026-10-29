import { parseEnv } from 'node:util';

/** Fail before any deployment command: inspect root and named environments, even disabled flags. */
export function assertDeployable(config: unknown, varsFiles: readonly string[] = [], inherited: NodeJS.ProcessEnv = {}): void {
  const localSetting = (key: string) => key.startsWith('RF_DEV_AUTH') || key === 'RF_LOCAL_SERVICES' || key === 'LOCAL_SERVICES';
  if (Object.keys(inherited).some(localSetting)) throw new Error('Deployment refuses local sign-in or stand-in variables.');
  for (const file of varsFiles) if (Object.keys(parseEnv(file)).some(localSetting)) throw new Error('Deployment refuses local sign-in or stand-in vars files.');
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (localSetting(key) || ((key === 'binding' || key === 'name') && child === 'LOCAL_SERVICES') || (key === 'class_name' && child === 'LocalServices')
        || (key === 'main' && typeof child === 'string' && /(?:^|\/)local\.ts$/u.test(child.replaceAll('\\', '/')))) throw new Error('Deployment refuses local sign-in or stand-in configuration or entrypoints.');
      walk(child);
    }
  };
  walk(config);
}
