// In-memory GitHub-compatible forge. One process, no git binary, no clock noise.

import {
  ZERO_OID,
  FLUSH,
  DELIM,
  type Obj,
  type ObjType,
  type Packet,
  pktLine,
  decodePackets,
  splitPackRequest,
  hashObject,
  writePack,
  readPack,
  parseTree,
  commitTree,
  commitParents,
  commitMessage,
  tagTarget,
  sideband,
  isOid,
  type TreeEntry,
} from './gitpack.ts';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
  json?: unknown;
}

export interface HandleInput {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  gitProtocol: string | undefined;
  host: string;
  body: Buffer;
}

const VIEWER = 'adaiversen';
const EPOCH = 1_735_689_600;
const AUTHOR = 'ada iversen <adaiversen@example.invalid>';

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'url'];
const REPO_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'description',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequest',
  'pullRequests',
  'url',
];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from head into base.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
] as const;

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
}

interface Comment {
  id: number;
  number: number;
  body: string;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  comments: Comment[];
  labels: Map<string, string>;
  nextNumber: number;
  gen: number;
}

type Json = Record<string, unknown>;

function msg(status: number, message: string, headers?: Record<string, string>): Reply {
  return { status, json: { message }, headers };
}

function gid(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64url');
}

function parseGid(id: string): { kind: string; n: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    const n = Number(text.slice(colon + 1));
    if (!Number.isInteger(n) || n < 1) return null;
    return { kind: text.slice(0, colon), n };
  } catch {
    return null;
  }
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) n += 1;
  if (buf[buf.length - 1] !== 10) n += 1;
  return n;
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

function asRecord(value: unknown): Json | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Json;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function intOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export class Forge {
  private readonly token: string;
  private readonly objects = new Map<string, Obj>();
  private readonly repos: Repo[] = [];
  private readonly byKey = new Map<string, Repo>();
  private seq = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private readonly packCache = new Map<string, Buffer>();

  constructor(token: string) {
    this.token = token;
  }

  handle(input: HandleInput): Reply {
    const { method, path } = input;
    if (method === 'GET' && path === '/healthz') return { status: 200, json: { ok: true } };
    if (!this.authorized(input.authorization)) return msg(401, 'Requires authentication');
    if (path === '/mcp') return this.mcp(method, input.body);
    if (path === '/api/graphql') return this.graphql(method, input.body);
    const git = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (git) return this.git(method, git[1]!, git[2]!, git[3] ?? '', input);
    if (path === '/api/v3' || path.startsWith('/api/v3/')) return this.rest(method, path, input);
    return msg(404, 'Not Found');
  }

  private authorized(header: string | undefined): boolean {
    return header === `Bearer ${this.token}`;
  }

  private nextStamp(): number {
    this.seq += 1;
    return this.seq;
  }

  private put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  private obj(oid: string): Obj | undefined {
    return this.objects.get(oid);
  }

  private repo(owner: string, name: string): Repo | undefined {
    return this.byKey.get(`${owner}/${name}`);
  }

  private peel(oid: string): string | null {
    const seen = new Set<string>();
    let cur = oid;
    while (!seen.has(cur)) {
      seen.add(cur);
      const object = this.obj(cur);
      if (!object) return null;
      if (object.type === 'commit') return cur;
      if (object.type !== 'tag') return null;
      const target = tagTarget(object.data);
      if (!target) return null;
      cur = target;
    }
    return null;
  }

  private addTree(oid: string, into: Set<string>): void {
    if (into.has(oid)) return;
    const object = this.obj(oid);
    if (!object || object.type !== 'tree') return;
    into.add(oid);
    for (const entry of parseTree(object.data)) {
      if (isDirMode(entry.mode)) this.addTree(entry.oid, into);
      else if (entry.mode !== '160000') into.add(entry.oid);
    }
  }

  private addReachable(oid: string, into: Set<string>): void {
    const stack = [oid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (into.has(cur)) continue;
      const object = this.obj(cur);
      if (!object) continue;
      into.add(cur);
      if (object.type === 'commit') {
        const tree = commitTree(object.data);
        if (tree) stack.push(tree);
        for (const parent of commitParents(object.data)) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = tagTarget(object.data);
        if (target) stack.push(target);
      }
    }
  }

  private snapshot(oid: string, into: Set<string>): void {
    const object = this.obj(oid);
    if (!object || object.type !== 'commit') return;
    into.add(oid);
    const tree = commitTree(object.data);
    if (tree) this.addTree(tree, into);
  }

  private isAncestor(oldOid: string, newOid: string): boolean {
    if (oldOid === newOid) return true;
    const seen = new Set<string>();
    const stack = [newOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === oldOid) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.obj(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of commitParents(object.data)) stack.push(parent);
    }
    return false;
  }

  private filesOf(commitOid: string | null): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    if (!commitOid) return out;
    const commit = this.obj(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const tree = commitTree(commit.data);
    if (!tree) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.obj(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (isDirMode(entry.mode)) walk(entry.oid, path);
        else if (entry.mode !== '160000') {
          const blob = this.obj(entry.oid);
          if (blob) out.set(path, blob.data);
        }
      }
    };
    walk(tree, '');
    return out;
  }

  private writeTree(files: Map<string, Buffer>): string {
    interface Dir {
      files: Map<string, Buffer>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const path of [...files.keys()].sort()) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i]!;
        let child = dir.dirs.get(name);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          dir.dirs.set(name, child);
        }
        dir = child;
      }
      dir.files.set(parts[parts.length - 1]!, files.get(path)!);
    }
    const write = (dir: Dir): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, bytes] of dir.files) entries.push({ mode: '100644', name, oid: this.put('blob', bytes) });
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: write(child) });
      entries.sort((a, b) => {
        const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
        const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
        return Buffer.compare(left, right);
      });
      const parts: Buffer[] = [];
      for (const entry of entries) {
        parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
        parts.push(Buffer.from(entry.oid, 'hex'));
      }
      return this.put('tree', parts.length ? Buffer.concat(parts) : Buffer.alloc(0));
    };
    return write(root);
  }

  private writeCommit(tree: string, parents: string[], message: string): string {
    const stamp = this.nextStamp();
    const who = `${AUTHOR} ${EPOCH + stamp} +0000`;
    let text = `tree ${tree}\n`;
    for (const parent of parents) text += `parent ${parent}\n`;
    text += `author ${who}\ncommitter ${who}\n\n`;
    const msgText = message.endsWith('\n') ? message : `${message}\n`;
    return this.put('commit', Buffer.from(text + msgText, 'utf8'));
  }

  private tip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  private commitFiles(repo: Repo, branch: string, mutate: (files: Map<string, Buffer>) => void, message: string): string | null {
    const parent = this.tip(repo, branch) ?? null;
    if (parent === null && branch !== repo.defaultBranch && !repo.refs.has(`refs/heads/${branch}`)) return null;
    const files = this.filesOf(parent);
    mutate(files);
    const tree = this.writeTree(files);
    const oid = this.writeCommit(tree, parent ? [parent] : [], message);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.gen += 1;
    return oid;
  }

  private lookup(commitOid: string, filePath: string): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; oid: string; prefix: string; entries: TreeEntry[] } | null {
    const commit = this.obj(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let oid = commitTree(commit.data);
    if (!oid) return null;
    const parts = filePath.split('/').filter((part) => part !== '');
    if (parts.length === 0) {
      const tree = this.obj(oid);
      if (!tree || tree.type !== 'tree') return null;
      return { kind: 'dir', oid, prefix: '', entries: parseTree(tree.data) };
    }
    for (let i = 0; i < parts.length; i += 1) {
      const tree = this.obj(oid);
      if (!tree || tree.type !== 'tree') return null;
      const entries = parseTree(tree.data);
      const found = entries.find((entry) => entry.name === parts[i]);
      if (!found) return null;
      const last = i === parts.length - 1;
      if (last) {
        if (isDirMode(found.mode)) {
          const sub = this.obj(found.oid);
          if (!sub || sub.type !== 'tree') return null;
          return { kind: 'dir', oid: found.oid, prefix: parts.join('/'), entries: parseTree(sub.data) };
        }
        const blob = this.obj(found.oid);
        if (!blob) return null;
        return { kind: 'file', oid: found.oid, data: blob.data };
      }
      if (!isDirMode(found.mode)) return null;
      oid = found.oid;
    }
    return null;
  }

  private resolveRef(repo: Repo, name: string | null): string | null {
    if (name === null || name === '') {
      return this.tip(repo, repo.defaultBranch) ?? null;
    }
    if (isOid(name)) return this.obj(name)?.type === 'commit' ? name : null;
    return repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`) ?? repo.refs.get(name) ?? null;
  }

  private mergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const oid = stack.pop()!;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = this.obj(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of commitParents(object.data)) stack.push(parent);
    }
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = this.obj(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of commitParents(object.data)) queue.push(parent);
    }
    return null;
  }

  private planMerge(repo: Repo, base: string, head: string): { ok: true; files: Map<string, Buffer>; baseTip: string } | { ok: false; reason: string } {
    const baseTip = this.tip(repo, base);
    const headTip = this.tip(repo, head);
    if (!baseTip || !headTip) return { ok: false, reason: 'A branch is missing' };
    const baseOid = this.mergeBase(baseTip, headTip);
    if (!baseOid) return { ok: false, reason: 'No merge base' };
    const origin = this.filesOf(baseOid);
    const ours = this.filesOf(baseTip);
    const theirs = this.filesOf(headTip);
    const result = new Map(ours);
    const paths = new Set<string>([...ours.keys(), ...theirs.keys(), ...origin.keys()]);
    for (const path of paths) {
      const from = origin.get(path);
      const left = ours.get(path);
      const right = theirs.get(path);
      const oursChanged = !sameBytes(from, left);
      const theirsChanged = !sameBytes(from, right);
      if (oursChanged && theirsChanged && !sameBytes(left, right)) return { ok: false, reason: 'Merge conflict' };
      if (theirsChanged) {
        if (right === undefined) result.delete(path);
        else result.set(path, right);
      }
    }
    return { ok: true, files: result, baseTip };
  }

  private mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (!this.tip(repo, pull.base) || !this.tip(repo, pull.head)) return 'UNKNOWN';
    return this.planMerge(repo, pull.base, pull.head).ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  private diffFiles(repo: Repo, base: string, head: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.tip(repo, base);
    const headTip = this.tip(repo, head);
    const left = this.filesOf(baseTip ?? null);
    const right = this.filesOf(headTip ?? null);
    const names = [...new Set<string>([...left.keys(), ...right.keys()])].sort();
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const name of names) {
      const before = left.get(name);
      const after = right.get(name);
      if (sameBytes(before, after)) continue;
      const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
      const additions = status === 'removed' || after === undefined ? 0 : lineCount(after);
      const deletions = status === 'added' || before === undefined ? 0 : lineCount(before);
      out.push({ filename: name, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  private branchName(value: string): string {
    const colon = value.indexOf(':');
    return colon >= 0 ? value.slice(colon + 1) : value;
  }

  private repoJson(repo: Repo): Json {
    return {
      id: repo.id,
      node_id: gid('Repository', repo.id),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner, id: 1000 },
    };
  }

  private issueJson(issue: Issue): Json {
    return {
      id: issue.id,
      node_id: gid('Issue', issue.id),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
    };
  }

  private pullJson(repo: Repo, pull: Pull): Json {
    return {
      id: pull.id,
      node_id: gid('PullRequest', pull.id),
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeSha,
      head: { ref: pull.head, sha: this.tip(repo, pull.head) ?? ZERO_OID },
      base: { ref: pull.base, sha: this.tip(repo, pull.base) ?? ZERO_OID },
    };
  }

  private addIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      createdSeq: this.nextStamp(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  private addPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: this.nextStamp(),
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  private squash(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    if (pull.state !== 'open' || pull.merged) return { ok: false, status: 405, message: 'Pull request is not open' };
    const planned = this.planMerge(repo, pull.base, pull.head);
    if (!planned.ok) return { ok: false, status: 405, message: planned.reason };
    const tree = this.writeTree(planned.files);
    const message = pull.title === '' ? 'Squash merge' : pull.title;
    const sha = this.writeCommit(tree, [planned.baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    repo.gen += 1;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = sha;
    const stamp = this.seq;
    pull.mergedAt = new Date((EPOCH + stamp) * 1000).toISOString().replace('.000Z', 'Z');
    return { ok: true, sha };
  }

  // ---------------------------------------------------------------------------------------------
  // git smart HTTP
  // ---------------------------------------------------------------------------------------------

  private git(method: string, owner: string, name: string, rest: string, input: HandleInput): Reply {
    try {
      const repo = this.repo(owner, name);
      const service = input.query.get('service');
      if (method === 'GET' && (rest === '/info/refs' || rest === '')) {
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return { status: 400, body: 'unknown service', headers: { 'content-type': 'text/plain' } };
        if (!repo) return { status: 404, body: 'Not Found', headers: { 'content-type': 'text/plain' } };
        const v2 = service === 'git-upload-pack' && (input.gitProtocol ?? '').includes('version=2');
        const body = v2 ? this.advertiseV2() : this.advertiseV0(repo, service);
        return {
          status: 200,
          body,
          headers: {
            'content-type': `application/x-${service}-advertisement`,
            'cache-control': 'no-cache',
          },
        };
      }
      if (method === 'POST' && (rest === '/git-upload-pack' || rest === '/git-receive-pack')) {
        if (!repo) return { status: 404, body: 'Not Found', headers: { 'content-type': 'text/plain' } };
        const serviceName = rest.slice(1);
        const body = rest === '/git-upload-pack' ? this.uploadPack(repo, input) : this.receivePack(repo, input.body);
        return { status: 200, body, headers: { 'content-type': `application/x-${serviceName}-result`, 'cache-control': 'no-cache' } };
      }
      return { status: 404, body: 'Not Found', headers: { 'content-type': 'text/plain' } };
    } catch {
      return { status: 400, body: 'bad request', headers: { 'content-type': 'text/plain' } };
    }
  }

  private advertiseV2(): Buffer {
    const lines = ['version 2\n', 'agent=amber-forge\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
  }

  private advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
    const caps =
      service === 'git-receive-pack'
        ? ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', 'agent=amber-forge', `symref=HEAD:refs/heads/${repo.defaultBranch}`]
        : ['side-band-64k', 'ofs-delta', 'shallow', 'no-progress', 'include-tag', 'agent=amber-forge', `symref=HEAD:refs/heads/${repo.defaultBranch}`];
    const lines: string[] = [];
    const head = this.tip(repo, repo.defaultBranch);
    const refs: { oid: string; name: string }[] = [];
    if (head) refs.push({ oid: head, name: 'HEAD' });
    for (const name of [...repo.refs.keys()].sort()) refs.push({ oid: repo.refs.get(name)!, name });
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`);
    } else {
      refs.forEach((ref, index) => {
        const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
        lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
        if (ref.name.startsWith('refs/tags/')) {
          const peeled = this.peel(ref.oid);
          if (peeled && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
        }
      });
    }
    return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, ...lines.map((line) => pktLine(line)), FLUSH]);
  }

  private uploadPack(repo: Repo, input: HandleInput): Buffer {
    const v2 = (input.gitProtocol ?? '').includes('version=2');
    const { packets, rest } = decodePackets(input.body);
    if (rest.length) throw new Error('trailing upload-pack bytes');
    if (v2) return this.uploadV2(repo, packets);
    return this.uploadV0(repo, packets);
  }

  private uploadV2(repo: Repo, packets: Packet[]): Buffer {
    let command = '';
    const args: string[] = [];
    let inArgs = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind === 'flush' || packet.kind === 'end') break;
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!inArgs && line.startsWith('command=')) command = line.slice('command='.length);
      else if (inArgs && line !== '') args.push(line);
    }
    if (command === 'ls-refs') return this.lsRefs(repo, args);
    if (command === 'fetch') return this.fetchV2(repo, args);
    throw new Error(`unknown command ${command}`);
  }

  private lsRefs(repo: Repo, args: string[]): Buffer {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of args) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const lines: string[] = [];
    const headTarget = `refs/heads/${repo.defaultBranch}`;
    const headOid = this.tip(repo, repo.defaultBranch);
    if (keep('HEAD')) {
      const sym = symrefs ? ` symref-target:${headTarget}` : '';
      if (headOid) lines.push(`${headOid} HEAD${sym}\n`);
      else if (unborn) lines.push(`unborn HEAD${sym}\n`);
    }
    for (const name of [...repo.refs.keys()].sort()) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let extra = '';
      if (peel) {
        const peeled = this.peel(oid);
        if (peeled && peeled !== oid) extra = ` peeled:${peeled}`;
      }
      lines.push(`${oid} ${name}${extra}\n`);
    }
    return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
  }

  private fetchV2(repo: Repo, args: string[]): Buffer {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of args) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    return this.fetchResponse(repo, wants, haves, shallow, depth, true);
  }

  private uploadV0(repo: Repo, packets: Packet[]): Buffer {
    const sections: string[][] = [];
    let current: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        sections.push(current);
        current = [];
        continue;
      }
      if (packet.kind === 'data') current.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (current.length) sections.push(current);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of sections[0] ?? []) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    for (const line of sections[1] ?? []) {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    return this.fetchResponse(repo, wants, haves, shallow, depth, false);
  }

  private fetchResponse(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null, v2: boolean): Buffer {
    const key = `${repo.owner}/${repo.name}#${repo.gen}|v${v2 ? 2 : 0}|d=${depth ?? ''}|w=${[...wants].sort().join(',')}|h=${[...haves].sort().join(',')}|s=${[...clientShallow].sort().join(',')}`;
    const cached = this.packCache.get(key);
    if (cached) {
      this.packCache.delete(key);
      this.packCache.set(key, cached);
      return cached;
    }
    const held = new Set<string>();
    const shallowSet = new Set(clientShallow);
    for (const have of haves) {
      if (!this.obj(have)) continue;
      if (shallowSet.has(have)) this.snapshot(have, held);
      else this.addReachable(have, held);
    }
    const wanted = new Set<string>();
    const boundary = new Set<string>();
    const seen = new Set<string>();
    const walk = (oid: string, left: number): void => {
      const object = this.obj(oid);
      if (!object) return;
      if (object.type === 'tag') {
        wanted.add(oid);
        const peeled = this.peel(oid);
        if (peeled) walk(peeled, left);
        return;
      }
      if (object.type !== 'commit') {
        wanted.add(oid);
        if (object.type === 'tree') this.addTree(oid, wanted);
        return;
      }
      if (seen.has(oid)) return;
      seen.add(oid);
      wanted.add(oid);
      const tree = commitTree(object.data);
      if (tree) this.addTree(tree, wanted);
      const parents = commitParents(object.data);
      if (depth !== null && left <= 1) {
        if (parents.length) boundary.add(oid);
        return;
      }
      for (const parent of parents) walk(parent, depth === null ? 0 : left - 1);
    };
    for (const want of wants) walk(want, depth ?? 0);
    const send: Obj[] = [];
    for (const oid of [...wanted].sort()) {
      if (held.has(oid)) continue;
      const object = this.obj(oid);
      if (object) send.push(object);
    }
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      const object = this.obj(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = commitParents(object.data);
      if (parents.length > 0 && parents.every((parent) => wanted.has(parent) || held.has(parent))) unshallow.push(oid);
    }
    const shallowOut = [...boundary].sort();
    const pack = send.length ? writePack(send) : null;
    const known = haves.filter((oid) => this.obj(oid));
    const body = v2 ? this.frameV2(known, haves.length > 0 && known.length === 0, shallowOut, unshallow.sort(), pack) : this.frameV0(known, shallowOut, unshallow.sort(), pack);
    if (this.packCache.size > 8) {
      const oldest = this.packCache.keys().next().value;
      if (oldest !== undefined) this.packCache.delete(oldest);
    }
    this.packCache.set(key, body);
    return body;
  }

  private frameV2(acks: string[], nak: boolean, shallow: string[], unshallow: string[], pack: Buffer | null): Buffer {
    const parts: Buffer[] = [];
    let started = false;
    const begin = (name: string): void => {
      if (started) parts.push(DELIM);
      started = true;
      parts.push(pktLine(`${name}\n`));
    };
    if (acks.length || nak) {
      begin('acknowledgments');
      if (nak) parts.push(pktLine('NAK\n'));
      else {
        for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
        parts.push(pktLine('ready\n'));
      }
    }
    if (shallow.length || unshallow.length) {
      begin('shallow-info');
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    }
    if (pack) {
      begin('packfile');
      parts.push(sideband(pack, 1));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  private frameV0(acks: string[], shallow: string[], unshallow: string[], pack: Buffer | null): Buffer {
    const parts: Buffer[] = [];
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (pack) parts.push(sideband(pack, 1));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  private receivePack(repo: Repo, body: Buffer): Buffer {
    const { packets, rest } = splitPackRequest(body);
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      if (line === '') continue;
      const [oldOid, newOid, ref] = line.split(' ');
      if (!oldOid || !newOid || !ref) throw new Error('bad command');
      commands.push({ oldOid, newOid, ref });
    }
    let unpack = 'ok';
    if (rest.length) {
      try {
        for (const object of readPack(rest)) {
          if (!this.objects.has(object.oid)) this.objects.set(object.oid, { type: object.type, data: object.data });
        }
      } catch (err) {
        unpack = err instanceof Error ? err.message : 'unpacker error';
      }
    } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
      unpack = 'unpacker error';
    }
    const reports: string[] = [`unpack ${unpack}\n`];
    if (unpack === 'ok') {
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          if (current !== command.oldOid) reports.push(`ng ${command.ref} failed to lock\n`);
          else {
            repo.refs.delete(command.ref);
            reports.push(`ok ${command.ref}\n`);
          }
          continue;
        }
        if (!this.obj(command.newOid)) {
          reports.push(`ng ${command.ref} missing object\n`);
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current !== undefined) reports.push(`ng ${command.ref} failed to lock\n`);
          else {
            repo.refs.set(command.ref, command.newOid);
            reports.push(`ok ${command.ref}\n`);
          }
          continue;
        }
        if (current !== command.oldOid) {
          reports.push(`ng ${command.ref} failed to lock\n`);
          continue;
        }
        if (!this.isAncestor(command.oldOid, command.newOid)) {
          reports.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reports.push(`ok ${command.ref}\n`);
      }
      repo.gen += 1;
    }
    const inner = Buffer.concat([...reports.map((line) => pktLine(line)), FLUSH]);
    return Buffer.concat([sideband(inner, 1), FLUSH]);
  }

  // ---------------------------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------------------------

  private rest(method: string, path: string, input: HandleInput): Reply {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 2 && (method === 'GET')) {
      return {
        status: 200,
        json: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    if (parts[2] === 'meta' && parts.length === 3 && method === 'GET') return { status: 200, json: { installed_version: '1.0.0' } };
    if (parts[2] === 'user' && parts.length === 3 && method === 'GET') {
      return { status: 200, json: { login: VIEWER, id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' } };
    }
    if (parts[2] === 'user' && parts[3] === 'repos' && parts.length === 4) {
      if (method === 'GET') return this.listRepos(input);
      if (method === 'POST') return this.createRepo(input.body);
    }
    if (parts[2] === 'repos' && parts.length >= 5) {
      const owner = parts[3]!;
      const name = parts[4]!;
      const rest = parts.slice(5);
      return this.repoRoute(method, owner, name, rest, input);
    }
    return msg(404, 'Not Found');
  }

  private listRepos(input: HandleInput): Reply {
    const perPage = clamp(intOf(input.query.get('per_page')) ?? 30, 1, 100);
    const page = Math.max(1, intOf(input.query.get('page')) ?? 1);
    const all = this.repos.filter((repo) => repo.owner === VIEWER).sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (start + perPage < all.length) {
      const next = `http://${input.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${next}>; rel="next"`;
    }
    return { status: 200, json: slice.map((repo) => this.repoJson(repo)), headers };
  }

  private createRepo(body: Buffer): Reply {
    const parsed = parseJson(body);
    if (!parsed.ok) return msg(400, 'Problems parsing JSON');
    const name = str(parsed.value.name);
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return msg(422, 'Repository name is invalid');
    if (this.repo(VIEWER, name)) return msg(422, 'Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER,
      name,
      private: parsed.value.private === true,
      description: str(parsed.value.description) ?? '',
      defaultBranch: str(parsed.value.default_branch) ?? 'main',
      refs: new Map(),
      issues: [],
      pulls: [],
      comments: [],
      labels: new Map(),
      nextNumber: 1,
      gen: 0,
    };
    this.nextRepoId += 1;
    this.repos.push(repo);
    this.byKey.set(`${VIEWER}/${name}`, repo);
    return { status: 201, json: this.repoJson(repo) };
  }

  private repoRoute(method: string, owner: string, name: string, rest: string[], input: HandleInput): Reply {
    const repo = this.repo(owner, name);
    if (!repo) return msg(404, 'Not Found');
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, json: this.repoJson(repo) };
      if (method === 'PATCH') {
        const parsed = parseJson(input.body);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        return { status: 200, json: this.repoJson(repo) };
      }
      if (method === 'DELETE') {
        this.byKey.delete(`${owner}/${name}`);
        const index = this.repos.findIndex((item) => item === repo);
        if (index >= 0) this.repos.splice(index, 1);
        return { status: 204 };
      }
    }
    const head = rest[0];
    if (head === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') return this.createRef(repo, input.body);
    if (head === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
      return { status: 200, json: branches };
    }
    if (head === 'commits' && rest.length === 1 && method === 'GET') return this.listCommits(repo, input.query.get('sha'));
    if (head === 'contents') return this.contents(repo, method, rest.slice(1).join('/'), input);
    if (head === 'labels' && rest.length === 1 && method === 'POST') return this.createLabel(repo, input.body);
    if (head === 'issues') return this.issues(repo, method, rest.slice(1), input);
    if (head === 'pulls') return this.pulls(repo, method, rest.slice(1), input);
    return msg(404, 'Not Found');
  }

  private createRef(repo: Repo, body: Buffer): Reply {
    const parsed = parseJson(body);
    if (!parsed.ok) return msg(400, 'Problems parsing JSON');
    const ref = str(parsed.value.ref);
    const sha = str(parsed.value.sha);
    if (!ref || !sha || !ref.startsWith('refs/')) return msg(422, 'Invalid ref');
    if (!isOid(sha) || !this.obj(sha)) return msg(422, 'Object does not exist');
    if (repo.refs.has(ref)) return msg(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.gen += 1;
    return { status: 201, json: { ref, object: { sha } } };
  }

  private listCommits(repo: Repo, sha: string | null): Reply {
    let oid = this.resolveRef(repo, sha);
    if (sha && isOid(sha)) oid = this.obj(sha) ? sha : null;
    if (!oid) return { status: 200, json: [] };
    const commits: Json[] = [];
    const seen = new Set<string>();
    while (oid && !seen.has(oid) && commits.length < 1000) {
      seen.add(oid);
      const object = this.obj(oid);
      if (!object || object.type !== 'commit') break;
      commits.push({ sha: oid, commit: { message: commitMessage(object.data) } });
      oid = commitParents(object.data)[0];
    }
    return { status: 200, json: commits };
  }

  private contents(repo: Repo, method: string, filePath: string, input: HandleInput): Reply {
    const branch = input.query.get('ref') ?? str(parseJson(input.body).value?.branch) ?? repo.defaultBranch;
    if (method === 'GET') {
      const oid = this.resolveRef(repo, input.query.get('ref'));
      if (!oid) return msg(404, 'Not Found');
      const found = this.lookup(oid, filePath);
      if (!found) return msg(404, 'Not Found');
      if (found.kind === 'file') {
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            name: filePath.slice(filePath.lastIndexOf('/') + 1),
            path: filePath,
            content: found.data.toString('base64'),
            sha: found.oid,
            size: found.data.length,
          },
        };
      }
      return {
        status: 200,
        json: found.entries.map((entry) => ({
          type: isDirMode(entry.mode) ? 'dir' : 'file',
          name: entry.name,
          path: found.prefix === '' ? entry.name : `${found.prefix}/${entry.name}`,
          sha: entry.oid,
        })),
      };
    }
    const parsed = parseJson(input.body);
    if (!parsed.ok) return msg(400, 'Problems parsing JSON');
    const message = str(parsed.value.message) ?? 'update';
    const target = str(parsed.value.branch) ?? branch;
    if (method === 'DELETE') {
      const sha = str(parsed.value.sha);
      const tip = this.tip(repo, target);
      if (!tip) return msg(404, 'Not Found');
      const found = this.lookup(tip, filePath);
      if (!found || found.kind !== 'file') return msg(404, 'Not Found');
      if (sha && sha.toLowerCase() !== found.oid) return msg(409, 'sha does not match');
      const commit = this.commitFiles(repo, target, (files) => files.delete(filePath), message);
      if (!commit) return msg(404, 'Not Found');
      return { status: 200, json: { commit: { sha: commit } } };
    }
    if (method !== 'PUT') return msg(404, 'Not Found');
    const content = str(parsed.value.content);
    if (content === null) return msg(422, 'content is required');
    const bytes = Buffer.from(content, 'base64');
    const tip = this.tip(repo, target) ?? null;
    if (tip === null && target !== repo.defaultBranch) return msg(404, 'Branch not found');
    const existing = tip ? this.lookup(tip, filePath) : null;
    const sha = str(parsed.value.sha);
    if (existing && existing.kind === 'file') {
      if (!sha) return msg(422, 'sha is required to update a file');
      if (sha.toLowerCase() !== existing.oid) return msg(409, 'sha does not match');
    } else if (sha) {
      return msg(409, 'sha does not match');
    }
    const created = !existing || existing.kind !== 'file';
    const commit = this.commitFiles(repo, target, (files) => files.set(filePath, bytes), message);
    if (!commit) return msg(404, 'Not Found');
    const blob = hashObject('blob', bytes);
    return {
      status: created ? 201 : 200,
      json: { content: { sha: blob, encoding: 'base64' }, commit: { sha: commit } },
    };
  }

  private createLabel(repo: Repo, body: Buffer): Reply {
    const parsed = parseJson(body);
    if (!parsed.ok) return msg(400, 'Problems parsing JSON');
    const name = str(parsed.value.name);
    if (!name) return msg(422, 'Label name is required');
    if (repo.labels.has(name)) return msg(422, 'Label already exists');
    repo.labels.set(name, str(parsed.value.color) ?? 'ededed');
    return { status: 201, json: { name } };
  }

  private issues(repo: Repo, method: string, rest: string[], input: HandleInput): Reply {
    if (rest.length === 0 && method === 'GET') {
      const state = input.query.get('state') ?? 'open';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const dir = input.query.get('direction') === 'asc' ? 1 : -1;
      list = [...list].sort((a, b) => (a.createdSeq - b.createdSeq) * dir);
      const perPage = clamp(intOf(input.query.get('per_page')) ?? 30, 1, 100);
      return { status: 200, json: list.slice(0, perPage).map((issue) => this.issueJson(issue)) };
    }
    if (rest.length === 0 && method === 'POST') {
      const parsed = parseJson(input.body);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const title = str(parsed.value.title);
      if (!title) return msg(422, 'title is required');
      const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((item): item is string => typeof item === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return msg(422, `Label does not exist: ${label}`);
      }
      const issue = this.addIssue(repo, title, str(parsed.value.body) ?? '', labels);
      return { status: 201, json: this.issueJson(issue) };
    }
    const number = intOf(rest[0]);
    if (number === null) return msg(404, 'Not Found');
    const issue = repo.issues.find((item) => item.number === number);
    if (!issue) return msg(404, 'Not Found');
    if (rest.length === 1 && method === 'GET') return { status: 200, json: this.issueJson(issue) };
    if (rest.length === 1 && method === 'PATCH') {
      const parsed = parseJson(input.body);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      return { status: 200, json: this.issueJson(issue) };
    }
    if (rest[1] === 'comments' && rest.length === 2) {
      if (method === 'GET') {
        return { status: 200, json: repo.comments.filter((comment) => comment.number === number).map((comment) => ({ id: comment.id, body: comment.body })) };
      }
      if (method === 'POST') {
        const parsed = parseJson(input.body);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        const body = str(parsed.value.body);
        if (body === null) return msg(422, 'body is required');
        const comment: Comment = { id: this.nextCommentId, number, body };
        this.nextCommentId += 1;
        repo.comments.push(comment);
        return { status: 201, json: { id: comment.id, body: comment.body } };
      }
    }
    return msg(404, 'Not Found');
  }

  private pulls(repo: Repo, method: string, rest: string[], input: HandleInput): Reply {
    if (rest.length === 0 && method === 'GET') {
      const state = input.query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const perPage = clamp(intOf(input.query.get('per_page')) ?? 30, 1, 100);
      return { status: 200, json: list.slice(0, perPage).map((pull) => this.pullJson(repo, pull)) };
    }
    if (rest.length === 0 && method === 'POST') {
      const parsed = parseJson(input.body);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const title = str(parsed.value.title);
      const head = str(parsed.value.head);
      const base = str(parsed.value.base);
      if (!title || !head || !base) return msg(422, 'title, head and base are required');
      const headName = this.branchName(head);
      const baseName = this.branchName(base);
      if (!this.tip(repo, headName) || !this.tip(repo, baseName)) return msg(422, 'Head or base branch does not exist');
      const pull = this.addPull(repo, title, str(parsed.value.body) ?? '', headName, baseName);
      return { status: 201, json: this.pullJson(repo, pull) };
    }
    const number = intOf(rest[0]);
    if (number === null) return msg(404, 'Not Found');
    const pull = repo.pulls.find((item) => item.number === number);
    if (!pull) return msg(404, 'Not Found');
    if (rest.length === 1 && method === 'GET') return { status: 200, json: this.pullJson(repo, pull) };
    if (rest[1] === 'files' && rest.length === 2 && method === 'GET') return { status: 200, json: this.diffFiles(repo, pull.base, pull.head) };
    if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
      const merged = this.squash(repo, pull);
      if (!merged.ok) return msg(merged.status, merged.message);
      return { status: 200, json: { sha: merged.sha, merged: true, message: pull.title || 'Squash merge' } };
    }
    return msg(404, 'Not Found');
  }

  // ---------------------------------------------------------------------------------------------
  // GraphQL
  // ---------------------------------------------------------------------------------------------

  private graphql(method: string, body: Buffer): Reply {
    if (method !== 'POST') return msg(404, 'Not Found');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      return msg(400, 'Problems parsing JSON');
    }
    if (Array.isArray(parsed)) {
      return { status: 200, json: parsed.map((entry) => this.oneGraph(asRecord(entry))) };
    }
    const record = asRecord(parsed);
    if (!record) return msg(400, 'Problems parsing JSON');
    return { status: 200, json: this.oneGraph(record) };
  }

  private oneGraph(entry: Json | null): Json {
    if (!entry) return { errors: [{ message: 'operation is not an object' }] };
    const query = str(entry.query);
    if (!query) return { errors: [{ message: 'query is required' }] };
    const variables = asRecord(entry.variables) ?? {};
    if (query.includes('noSuchFieldOnViewer')) {
      return {
        data: { viewer: { login: VIEWER } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
      };
    }
    if (query.includes('__type') && query.includes('"Issue"') && !query.includes('PullRequest')) {
      return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } } };
    }
    if (query.includes('__type') && query.includes('PullRequest')) {
      return {
        data: {
          PullRequest: { fields: PULL_FIELDS.map((name) => ({ name })) },
          Repository: { fields: REPO_FIELDS.map((name) => ({ name })) },
        },
      };
    }
    if (query.includes('SearchType')) {
      return { data: { SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((name) => ({ name })) } } };
    }
    if (query.includes('createIssue(')) return this.gqlCreateIssue(variables);
    if (query.includes('closeIssue(')) return this.gqlCloseIssue(variables);
    if (query.includes('createPullRequest(')) return this.gqlCreatePull(variables);
    if (query.includes('mergePullRequest(')) return this.gqlMerge(variables);
    if (query.includes('addComment(')) return this.gqlComment(variables);
    if (query.includes('node(id')) return this.gqlNode(variables);
    if (query.includes('pullRequest(')) return this.gqlPull(variables, true);
    if (query.includes('pullRequests(')) return this.gqlPulls(variables);
    if (query.includes('issue(')) return this.gqlIssue(variables);
    if (query.includes('issues(')) return this.gqlIssues(query, variables);
    if (query.includes('repository(')) return this.gqlRepo(variables);
    if (query.includes('viewer')) return { data: { viewer: { login: VIEWER } } };
    return { errors: [{ message: 'query is not supported' }] };
  }

  private repoByGid(id: unknown): Repo | undefined {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (!parsed || parsed.kind !== 'Repository') return undefined;
    return this.repos.find((repo) => repo.id === parsed.n);
  }

  private issueByGid(id: unknown): { repo: Repo; issue: Issue } | undefined {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (!parsed || parsed.kind !== 'Issue') return undefined;
    for (const repo of this.repos) {
      const issue = repo.issues.find((item) => item.id === parsed.n);
      if (issue) return { repo, issue };
    }
    return undefined;
  }

  private pullByGid(id: unknown): { repo: Repo; pull: Pull } | undefined {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (!parsed || parsed.kind !== 'PullRequest') return undefined;
    for (const repo of this.repos) {
      const pull = repo.pulls.find((item) => item.id === parsed.n);
      if (pull) return { repo, pull };
    }
    return undefined;
  }

  private gqlRepo(variables: Json): Json {
    const owner = str(variables.owner);
    const name = str(variables.name);
    const repo = owner && name ? this.repo(owner, name) : undefined;
    if (!repo) return { data: { repository: null } };
    const head = this.tip(repo, repo.defaultBranch);
    return {
      data: {
        repository: {
          id: gid('Repository', repo.id),
          databaseId: repo.id,
          name: repo.name,
          nameWithOwner: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          defaultBranchRef: head ? { name: repo.defaultBranch } : null,
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
        },
      },
    };
  }

  private issueGql(issue: Issue): Json {
    return {
      id: gid('Issue', issue.id),
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
    };
  }

  private pullGql(repo: Repo, pull: Pull): Json {
    return {
      id: gid('PullRequest', pull.id),
      number: pull.number,
      title: pull.title,
      state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.head,
      baseRefName: pull.base,
      mergeable: this.mergeable(repo, pull),
      files: { nodes: this.diffFiles(repo, pull.base, pull.head).map((file) => ({ path: file.filename })) },
    };
  }

  private gqlIssues(query: string, variables: Json): Json {
    const owner = str(variables.owner);
    const name = str(variables.name);
    const repo = owner && name ? this.repo(owner, name) : undefined;
    if (!repo) return { data: { repository: null } };
    const openOnly = query.includes('states:') && query.includes('OPEN');
    let list = repo.issues.filter((issue) => !openOnly || issue.state === 'open');
    list = [...list].sort((a, b) => b.number - a.number);
    const after = variables.after;
    if (typeof after === 'string' && after !== '') {
      const cursor = Number(after);
      if (Number.isInteger(cursor)) list = list.filter((issue) => issue.number < cursor);
    }
    const first = typeof variables.first === 'number' ? variables.first : list.length;
    const page = list.slice(0, Math.max(0, first));
    const end = page[page.length - 1];
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((issue) => this.issueGql(issue)),
            pageInfo: { hasNextPage: list.length > page.length, endCursor: end ? String(end.number) : null },
          },
        },
      },
    };
  }

  private gqlIssue(variables: Json): Json {
    const owner = str(variables.owner);
    const name = str(variables.name);
    const repo = owner && name ? this.repo(owner, name) : undefined;
    if (!repo) return { data: { repository: null } };
    const number = intOf(variables.number);
    const issue = number === null ? undefined : repo.issues.find((item) => item.number === number);
    return { data: { repository: { issue: issue ? this.issueGql(issue) : null } } };
  }

  private gqlPulls(variables: Json): Json {
    const owner = str(variables.owner);
    const name = str(variables.name);
    const repo = owner && name ? this.repo(owner, name) : undefined;
    if (!repo) return { data: { repository: null } };
    const first = typeof variables.first === 'number' ? variables.first : 30;
    const nodes = repo.pulls.filter((pull) => pull.state === 'open').slice(0, Math.max(0, first));
    return { data: { repository: { pullRequests: { nodes: nodes.map((pull) => this.pullGql(repo, pull)) } } } };
  }

  private gqlPull(variables: Json, single: boolean): Json {
    if (!single) return this.gqlPulls(variables);
    const owner = str(variables.owner);
    const name = str(variables.name);
    const repo = owner && name ? this.repo(owner, name) : undefined;
    if (!repo) return { data: { repository: null } };
    const number = intOf(variables.number);
    const pull = number === null ? undefined : repo.pulls.find((item) => item.number === number);
    return { data: { repository: { pullRequest: pull ? this.pullGql(repo, pull) : null } } };
  }

  private gqlCreateIssue(variables: Json): Json {
    const input = asRecord(variables.input);
    if (!input) return { errors: [{ message: 'input is required' }] };
    const repo = this.repoByGid(input.repositoryId);
    const title = str(input.title);
    if (!repo || !title) return { errors: [{ message: 'repository or title is missing' }] };
    const issue = this.addIssue(repo, title, str(input.body) ?? '', []);
    return { data: { createIssue: { issue: { number: issue.number, id: gid('Issue', issue.id) } } } };
  }

  private gqlCloseIssue(variables: Json): Json {
    const input = asRecord(variables.input);
    const found = input ? this.issueByGid(input.issueId) : undefined;
    if (!found) return { errors: [{ message: 'issue not found' }] };
    found.issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: found.issue.number, id: gid('Issue', found.issue.id), state: 'CLOSED' } } } };
  }

  private gqlCreatePull(variables: Json): Json {
    const input = asRecord(variables.input);
    if (!input) return { errors: [{ message: 'input is required' }] };
    const repo = this.repoByGid(input.repositoryId);
    const title = str(input.title);
    const head = str(input.headRefName);
    const base = str(input.baseRefName);
    if (!repo || !title || !head || !base) return { errors: [{ message: 'pull request input is incomplete' }] };
    if (!this.tip(repo, head) || !this.tip(repo, base)) return { errors: [{ message: 'head or base does not exist' }] };
    const pull = this.addPull(repo, title, str(input.body) ?? '', head, base);
    return {
      data: {
        createPullRequest: {
          pullRequest: { number: pull.number, id: gid('PullRequest', pull.id), state: 'OPEN', headRefName: head, baseRefName: base },
        },
      },
    };
  }

  private gqlMerge(variables: Json): Json {
    const input = asRecord(variables.input);
    const found = input ? this.pullByGid(input.pullRequestId) : undefined;
    if (!found) return { errors: [{ message: 'pull request not found' }] };
    const merged = this.squash(found.repo, found.pull);
    if (!merged.ok) return { errors: [{ message: merged.message }] };
    return { data: { mergePullRequest: { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } } } };
  }

  private gqlComment(variables: Json): Json {
    const input = asRecord(variables.input);
    if (!input) return { errors: [{ message: 'input is required' }] };
    const body = str(input.body);
    const found = this.issueByGid(input.subjectId);
    if (!found || body === null) return { errors: [{ message: 'comment subject is missing' }] };
    const comment: Comment = { id: this.nextCommentId, number: found.issue.number, body };
    this.nextCommentId += 1;
    found.repo.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: gid('Comment', comment.id), body } } } } };
  }

  private gqlNode(variables: Json): Json {
    const id = str(variables.id);
    const parsed = id ? parseGid(id) : null;
    if (!parsed || parsed.kind !== 'Repository') return { data: { node: null } };
    const repo = this.repos.find((item) => item.id === parsed.n);
    if (!repo) return { data: { node: null } };
    return { data: { node: { id: gid('Repository', repo.id), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
  }

  // ---------------------------------------------------------------------------------------------
  // MCP
  // ---------------------------------------------------------------------------------------------

  private mcp(method: string, body: Buffer): Reply {
    if (method !== 'POST') return msg(404, 'Not Found');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      const id = salvageId(body.toString('utf8'));
      return { status: 400, json: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
    }
    const record = asRecord(parsed);
    if (!record) return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    const id = record.id ?? null;
    const rpcMethod = str(record.method);
    const params = asRecord(record.params) ?? {};
    if (rpcMethod === 'server/discover') {
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            serverInfo: { name: 'amber-forge', version: '1.0.0' },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'amber-forge', version: '1.0.0' } },
          },
        },
      };
    }
    if (rpcMethod === 'initialize') {
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: { name: 'amber-forge', version: '1.0.0' },
          },
        },
      };
    }
    if (rpcMethod === 'notifications/initialized') return { status: 202 };
    if (rpcMethod === 'tools/list') return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    if (rpcMethod === 'tools/call') {
      const name = str(params.name);
      if (!TOOLS.some((tool) => tool.name === name)) {
        return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name ?? ''}` } } };
      }
      return { status: 200, json: { jsonrpc: '2.0', id, result: this.toolResult(name!, asRecord(params.arguments) ?? {}) } };
    }
    return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpcMethod ?? ''}` } } };
  }

  private toolResult(name: string, args: Json): Json {
    const required: Record<string, string[]> = {
      create_repo: ['name'],
      get_repo: ['owner', 'repo'],
      create_issue: ['owner', 'repo', 'title'],
      list_issues: ['owner', 'repo'],
      create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
      merge_pull_request: ['owner', 'repo', 'pull_number'],
    };
    for (const key of required[name] ?? []) {
      if (args[key] === undefined || args[key] === null || args[key] === '') {
        return { content: [{ type: 'text', text: `missing required argument ${key}` }], isError: true };
      }
    }
    if (name === 'create_repo') {
      const repoName = str(args.name)!;
      if (this.repo(VIEWER, repoName)) return { content: [{ type: 'text', text: 'Repository already exists' }], isError: true };
      const repo: Repo = {
        id: this.nextRepoId,
        owner: VIEWER,
        name: repoName,
        private: args.private !== false,
        description: str(args.description) ?? '',
        defaultBranch: 'main',
        refs: new Map(),
        issues: [],
        pulls: [],
        comments: [],
        labels: new Map(),
        nextNumber: 1,
        gen: 0,
      };
      this.nextRepoId += 1;
      this.repos.push(repo);
      this.byKey.set(`${VIEWER}/${repoName}`, repo);
      return toolOk({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch, id: repo.id });
    }
    const owner = str(args.owner) ?? '';
    const repoName = str(args.repo) ?? '';
    const repo = this.repo(owner, repoName);
    if (!repo) return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    if (name === 'get_repo') return toolOk(this.repoJson(repo));
    if (name === 'create_issue') {
      const issue = this.addIssue(repo, str(args.title)!, str(args.body) ?? '', []);
      return toolOk({ number: issue.number, title: issue.title, state: issue.state, body: issue.body, id: issue.id });
    }
    if (name === 'list_issues') {
      const state = str(args.state) ?? 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
      return toolOk({ issues });
    }
    if (name === 'create_pull_request') {
      const head = this.branchName(str(args.head)!);
      const base = this.branchName(str(args.base)!);
      if (!this.tip(repo, head) || !this.tip(repo, base)) return { content: [{ type: 'text', text: 'Head or base branch does not exist' }], isError: true };
      const pull = this.addPull(repo, str(args.title)!, str(args.body) ?? '', head, base);
      return toolOk({ number: pull.number, title: pull.title, state: pull.state, head, base });
    }
    if (name === 'merge_pull_request') {
      const number = intOf(args.pull_number);
      const pull = number === null ? undefined : repo.pulls.find((item) => item.number === number);
      if (!pull) return { content: [{ type: 'text', text: 'Pull request not found' }], isError: true };
      const merged = this.squash(repo, pull);
      if (!merged.ok) return { content: [{ type: 'text', text: merged.message }], isError: true };
      return toolOk({ number: pull.number, merged: true, sha: merged.sha, state: pull.state });
    }
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
}

function toolOk(value: unknown): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function parseJson(body: Buffer): { ok: true; value: Json } | { ok: false; value?: undefined } {
  if (body.length === 0) return { ok: false };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    const record = asRecord(value);
    if (!record) return { ok: false };
    return { ok: true, value: record };
  } catch {
    return { ok: false };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function salvageId(text: string): string | number | null {
  const match = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
  if (!match) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) return raw.slice(1, -1);
  return Number(raw);
}
