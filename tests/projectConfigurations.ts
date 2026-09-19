/** Assemble current Project settings for execution fixtures at the repository boundary. */
export function withConfigurations<P, C, R>(
  projects: R & { get(name: string): Promise<P | null> },
  configurationFor: (name: string) => Promise<C>,
) {
  return {
    ...projects,
    async get(name: string) {
      const project = await projects.get(name);
      return project === null ? null : { ...project, configuration: await configurationFor(name) };
    },
  };
}
