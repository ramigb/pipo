// Turns a GitHub push event into a build: the repository to fetch, the commit and the branch. Other events (GitHub
// sends `ping` when a webhook is added) and branch deletions come out without a sha, and ci.pipo's `main` filter
// drops them.

interface PushEvent {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string; clone_url?: string };
  head_commit?: { message?: string; url?: string; author?: { name?: string } } | null;
  pusher?: { name?: string };
}

export function fromPush(event: PushEvent) {
  const ref = event.ref ?? "";
  if (!ref.startsWith("refs/heads/") || event.deleted || !event.after || !event.repository?.clone_url) {
    return { event: "ignored", ref };
  }
  return {
    repo: event.repository.clone_url,
    name: event.repository.full_name ?? event.repository.clone_url,
    sha: event.after,
    branch: ref.slice("refs/heads/".length),
    message: (event.head_commit?.message ?? "").split("\n")[0],
    author: event.head_commit?.author?.name ?? event.pusher?.name ?? "unknown",
    url: event.head_commit?.url ?? null,
  };
}
