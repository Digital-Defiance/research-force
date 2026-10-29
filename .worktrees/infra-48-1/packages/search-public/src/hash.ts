/** cyrb53: a fast 53-bit string hash for content-addressed file names and shard placement, not for security. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 14 hex digits that change whenever the content changes. */
export const contentHash = (content: string): string => cyrb53(content).toString(16).padStart(14, '0');

/** The document shard of a key; the builder and the browser engine both place documents with it. */
export const shardOf = (key: string, shards: number): number => cyrb53(key, 0x5eed) % shards;
