/** Assemble current Agent settings for execution fixtures at the repository boundary. */
export function withConfigurations<P, C, R>(
  agents: R & { get(name: string): Promise<P | null> },
  configurationFor: (name: string) => Promise<C>,
) {
  return {
    ...agents,
    async get(name: string) {
      const agent = await agents.get(name);
      return agent === null ? null : { ...agent, configuration: await configurationFor(name) };
    },
  };
}
