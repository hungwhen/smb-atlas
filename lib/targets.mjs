import { isIP } from 'node:net';

export class TargetValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetValidationError';
  }
}

function invalid(token, reason = 'Use an IPv4 address, IPv6 address, or CIDR subnet.') {
  const shown = token.length > 90 ? `${token.slice(0, 87)}...` : token;
  throw new TargetValidationError(`Invalid target "${shown}". ${reason}`);
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Number(address) {
  // net.isIP validates first; dotted IPv4 tails occupy the final two groups.
  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    const tail = ipv4Number(address.slice(colon + 1));
    address = `${address.slice(0, colon + 1)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1
    ? left
    : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function formatIpv4(value) {
  return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
}

function formatIpv6(value) {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  // Canonicalize mapped dotted and hexadecimal spellings to the same address.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return `::ffff:${formatIpv4(value & 0xffffffffn)}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) { start += 1; continue; }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const text = groups.map(group => group.toString(16));
  if (bestStart < 0) return text.join(':');
  return `${text.slice(0, bestStart).join(':')}::${text.slice(bestStart + bestLength).join(':')}`;
}

function parseRange(token) {
  const pieces = token.split('/');
  if (pieces.length > 2) invalid(token);
  const address = pieces[0];
  // Zone IDs, brackets, UNC paths, URLs and ports are not target syntax.
  if (!/^[0-9a-fA-F:.]+$/.test(address)) invalid(token);
  const family = isIP(address);
  if (!family) invalid(token, 'Use a valid IP address; hostnames, ports, and leading-zero IPv4 octets are not supported.');
  const bits = family === 4 ? 32 : 128;
  let prefix = bits;
  if (pieces.length === 2) {
    if (!/^(0|[1-9][0-9]*)$/.test(pieces[1])) invalid(token, `The CIDR prefix must be an integer from 0 to ${bits}.`);
    prefix = Number(pieces[1]);
    if (!Number.isSafeInteger(prefix) || prefix > bits) invalid(token, `The CIDR prefix must be an integer from 0 to ${bits}.`);
  }
  const value = family === 4 ? ipv4Number(address) : ipv6Number(address);
  const hostBits = BigInt(bits - prefix);
  // Mask host bits, so 192.0.2.7/30 means the subnet 192.0.2.4/30.
  const network = (value >> hostBits) << hostBits;
  const size = 1n << hostBits;
  const omitEndpoints = family === 4 && prefix <= 30;
  return {
    family,
    first: network + (omitEndpoints ? 1n : 0n),
    last: network + size - (omitEndpoints ? 2n : 1n),
  };
}

/**
 * Expand IPs/CIDRs into canonical IP strings, sorted IPv4 then IPv6.
 * Tokens may be separated by whitespace, commas or semicolons; # starts a line comment.
 * IPv4 /0–/30 omits network/broadcast. /31 and /32, and all IPv6 subnets, include all addresses.
 * The union is counted with BigInt before enumerating, so large subnets fail promptly.
 */
export function parseTargets(input, { maxHosts = 4096 } = {}) {
  if (typeof input !== 'string') throw new TargetValidationError('Enter targets as text containing IP addresses or CIDR subnets.');
  if (!Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new TargetValidationError('maxHosts must be a positive safe integer.');
  const tokens = input.replace(/^\uFEFF/, '').replace(/#.*$/gm, '').split(/[\s,;]+/u).filter(Boolean);
  if (!tokens.length) throw new TargetValidationError('Enter at least one IP address or CIDR subnet.');
  const ranges = tokens.map(parseRange).sort((a, b) => a.family - b.family || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.family === range.family && range.first <= previous.last + 1n) {
      if (range.last > previous.last) previous.last = range.last;
    } else {
      merged.push({ ...range });
    }
  }
  const count = merged.reduce((sum, range) => sum + range.last - range.first + 1n, 0n);
  if (count > BigInt(maxHosts)) {
    throw new TargetValidationError(`Targets expand to ${count.toLocaleString('en-US')} unique hosts; the limit is ${maxHosts.toLocaleString('en-US')}. Use smaller subnets or fewer targets.`);
  }
  const result = [];
  for (const range of merged) {
    for (let value = range.first; value <= range.last; value += 1n) {
      result.push(range.family === 4 ? formatIpv4(value) : formatIpv6(value));
    }
  }
  return result;
}
