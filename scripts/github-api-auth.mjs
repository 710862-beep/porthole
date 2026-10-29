// Only the exact HTTPS GitHub API origin receives the runner's existing token.
// curl strips Authorization on cross-host redirects; never use --location-trusted.
export function githubAPIHeaders(url,env=process.env) {
  const parsed=new URL(url);
  return parsed.origin==='https://api.github.com' && !parsed.username && !parsed.password && env.GH_TOKEN
    ? ['-H',`Authorization: Bearer ${env.GH_TOKEN}`] : [];
}
