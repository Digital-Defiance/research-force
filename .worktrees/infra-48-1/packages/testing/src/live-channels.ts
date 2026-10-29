import type { PublicArtifact } from './public-channels';
import type { WorkspaceState } from './workspace';

/**
 * A channel whose output only a running Worker can produce, such as rf-dl's responses. The adapter lives with the Worker's workerd tests, which
 * inject the real handler; this package only defines the contract so that the privacy matrix cannot be satisfied by a constant (R60.1, R60.4).
 */
export interface LiveChannel {
  readonly name: string;
  /** The production module whose handler the adapter calls. */
  readonly source: string;
  /** How many real requests reached that handler. A stub that never calls it stays at zero. */
  invocations: number;
  artifacts(state: WorkspaceState): Promise<PublicArtifact[]>;
}

/** Channels the final gate requires an adapter for; new channels register here with their owning feature (task 68.4). */
export const REQUIRED_LIVE_CHANNELS: readonly { readonly name: string; readonly source: string }[] = Object.freeze([
  { name: 'rf-dl refusals to non-Members', source: 'apps/dl/src/index.ts' },
]);

/** What is wrong with the supplied adapters: a missing one, one that never reached the production handler, or one bound to a different module. */
export function liveChannelProblems(adapters: readonly LiveChannel[], required = REQUIRED_LIVE_CHANNELS): string[] {
  const problems: string[] = [];
  for (const channel of required) {
    const adapter = adapters.find((candidate) => candidate.name === channel.name);
    if (!adapter) problems.push(`Missing live adapter: ${channel.name}`);
    else if (adapter.source !== channel.source) problems.push(`Adapter ${channel.name} exercises ${adapter.source}, not ${channel.source}`);
    else if (adapter.invocations === 0) problems.push(`Adapter ${channel.name} never called the production handler (stub)`);
  }
  for (const adapter of adapters) if (!required.some((channel) => channel.name === adapter.name)) problems.push(`Unregistered live adapter: ${adapter.name}`);
  return problems;
}

/** A response as a crawler or other reader would see it: status, every header, and the body. */
export interface HttpResponseLike { readonly status: number; readonly headers: Iterable<readonly [string, string]>; text(): Promise<string> }
export async function responseArtifact(name: string, response: HttpResponseLike): Promise<PublicArtifact> {
  const headers = [...response.headers].map(([key, value]) => `${key}: ${value}`).sort().join('\n');
  return { name, content: `${response.status}\n${headers}\n\n${await response.text()}` };
}
