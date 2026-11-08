import { readConnection } from '../browse/server';
import { connectionService } from '../connections/server';
import { completeInstall, type InstallOutcome } from './install';
import { gitHubApp, installationProvider } from './server';

/**
 * Connect what an installation reaches for the account, with the instance's App and connection service. Each repository it connects is read once, as one connected with a token
 * is, so that its kind (which its tile and its icon in the rail are drawn from) is known when it is first seen; a failure to read it is not the connection's.
 */
export async function completeFor(
  accountId: string,
  input: { code: string; installationId: number },
): Promise<InstallOutcome> {
  const app = gitHubApp();
  if (!app) return { ok: false, reason: 'not_configured' };
  const service = await connectionService();
  const learning = {
    addFromInstallation: async (...args: Parameters<typeof service.addFromInstallation>) => {
      const result = await service.addFromInstallation(...args);
      for (const connection of result.added)
        await readConnection(accountId, connection).catch(() => undefined);
      return result;
    },
  };
  return completeInstall(
    {
      config: app.config,
      apiUrl: app.apiUrl,
      webUrl: app.webUrl,
      service: learning,
      installation: installationProvider,
    },
    accountId,
    input,
  );
}
