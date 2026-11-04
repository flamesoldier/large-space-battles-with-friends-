// Player accounts: one password per player, nothing else. The password alone says who you are,
// so every password is unique and long enough that guessing one is hopeless (60 random bits from
// generatePassword, plus a rate limit on logins in server.mjs).
//
// Only scrypt hashes are stored (data/accounts.json). Each account has a `gen` number that
// changes whenever its password does; sessions remember the gen they were made with, so
// resetting a password logs that player out everywhere.

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
// No 0/O, 1/l/I: easy to read out or type from a message.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A new random password like "k7pm-x3qa-9fwe" (12 characters from 31 → about 59 bits). */
export function generatePassword() {
  const out = [];
  while (out.length < 12) {
    const b = randomBytes(16);
    for (const x of b) if (x < 248 && out.length < 12) out.push(ALPHABET[x % 31]); // 248 = 31 × 8: no bias
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}

/** What people type is trimmed and lower-cased, so "K7PM-X3QA-9FWE " still works. */
export const normalizePassword = (pw) => String(pw ?? '').trim().toLowerCase();

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizePassword(pw), salt, KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(normalizePassword(pw), Buffer.from(salt, 'base64'), want.length, SCRYPT);
  return timingSafeEqual(want, got);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * accounts.json: { players: [{ id, gen, hash }] }, one entry per world player.
 * Re-read whenever the file changes, so `npm run admin -- reset-password` works on a running server.
 */
export class Accounts {
  constructor(file) { this.file = file; this.mtime = -1; this.list = []; }
  load() {
    if (!existsSync(this.file)) { this.list = []; this.mtime = -1; return this; }
    const m = statSync(this.file).mtimeMs;
    if (m !== this.mtime) { this.list = JSON.parse(readFileSync(this.file, 'utf8')).players; this.mtime = m; }
    return this;
  }
  save() { writeJsonAtomic(this.file, { players: this.list }); this.mtime = statSync(this.file).mtimeMs; }
  get(id) { return this.load().list.find((a) => a.id === id) ?? null; }
  /** The player whose password this is, or null. Checks every account (a few dozen ms each), so it's never quick to guess. */
  find(pw) {
    let hit = null;
    for (const a of this.load().list) if (checkPassword(pw, a.hash) && hit === null) hit = a;
    return hit;
  }
  /** Set a player's password (unique across players). Returns it. */
  setPassword(id, pw = generatePassword()) {
    this.load();
    if (normalizePassword(pw).length < 8) throw new Error('Passwords need at least 8 characters.');
    for (const a of this.list) if (a.id !== id && checkPassword(pw, a.hash)) throw new Error('Another player already has that password.');
    const a = this.list.find((x) => x.id === id);
    if (a) { a.hash = hashPassword(pw); a.gen = (a.gen || 0) + 1; } else this.list.push({ id, gen: 1, hash: hashPassword(pw) });
    this.list.sort((x, y) => x.id - y.id);
    this.save();
    return pw;
  }
}
