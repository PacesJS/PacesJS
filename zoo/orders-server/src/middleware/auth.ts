import { createHash } from 'node:crypto';

export function authenticate(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) throw new Error('unauthorized');
  let digest = header.slice(7);
  for (let i = 0; i < 400; i++) digest = createHash('sha256').update(digest).digest('hex');
  return digest;
}
