import { dockerCall } from "@/infrastructure/workspace/dockerProvider";

/** A credential-free, offline repository owned by the disposable Sandbox fixture. */
export async function createWorkspaceGitFixtureBundle(containerId: string): Promise<string> {
  const fixture = `
    const fs = require('node:fs'); const cp = require('node:child_process');
    const git = args => cp.execFileSync('git', args, {env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'},stdio:'pipe'});
    git(['init','-b','main','/control/source']);
    fs.writeFileSync('/control/source/hello.txt','before\\n');
    fs.writeFileSync('/control/source/.gitignore','node_modules/\\n');
    git(['-C','/control/source','add','.']); git(['-C','/control/source','commit','-m','fixture']);
    git(['-C','/control/source','bundle','create','/control/fixture.bundle','main']);
    process.stdout.write(fs.readFileSync('/control/fixture.bundle').toString('base64'));
  `;
  return dockerCall(["exec", "-i", "--user", "0", containerId, "node"], fixture);
}
