import {
  type SetupChoice,
  DEFAULT_JOURNAL_VAULT,
  DEFAULT_VAULT,
  planFirstCommit,
} from '../browse/setup';
import type { ConnectionInfo, ConnectionService } from '../connections/service';
import type { Fjord } from '../format/wasm';

/**
 * Making a repository on this server (ROADMAP 3i): a name and a kind, a drive or a journal for now. What its first commit holds is
 * `fjord-core`'s plan for it (`fjord.json`, the vault and its starter note, spec §9's `.gitattributes` line), the same files setting up a
 * repository in a git host writes, so that what is made here is a Fjord repository `fjord verify` accepts and a later sync is a plain copy.
 * A site is not offered: it needs a git host to build and preview it.
 */
export type LocalKind = 'drive' | 'journal';

export interface NewLocalRepository {
  name: string;
  kind: LocalKind;
}

export function choiceFor(kind: LocalKind): SetupChoice {
  return kind === 'journal'
    ? { kind: 'journal', vault: DEFAULT_JOURNAL_VAULT, encrypted: false, recipients: [] }
    : { kind: 'drive', vault: DEFAULT_VAULT };
}

export async function createLocalRepository(
  deps: {
    service: Pick<ConnectionService, 'addLocal'>;
    format: Pick<Fjord, 'planSetup' | 'planSetupKind'>;
    random?: () => Uint8Array;
    now?: () => number;
  },
  accountId: string,
  input: NewLocalRepository,
): Promise<ConnectionInfo> {
  const name = input.name.trim();
  const files = planFirstCommit(
    {
      format: deps.format as Fjord,
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    name,
    choiceFor(input.kind),
  );
  const connection = await deps.service.addLocal(accountId, { name, files });
  return connection;
}
