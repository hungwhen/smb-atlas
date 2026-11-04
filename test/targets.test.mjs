import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetPlan, parseTargets, TargetValidationError } from '../lib/targets.mjs';

test('accepts mixed separators, BOM and comments; sorts and deduplicates IPs', () => {
  assert.deepEqual(parseTargets('\uFEFF192.0.2.9,192.0.2.1; 192.0.2.9\n# lab\n2001:DB8::A # note\n192.0.2.2'),
    ['192.0.2.1', '192.0.2.2', '192.0.2.9', '2001:db8::a']);
});

test('IPv4 CIDRs mask host bits and handle /30, /31 and /32 endpoints', () => {
  assert.deepEqual(parseTargets('192.0.2.7/30'), ['192.0.2.5', '192.0.2.6']);
  assert.deepEqual(parseTargets('192.0.2.7/31'), ['192.0.2.6', '192.0.2.7']);
  assert.deepEqual(parseTargets('192.0.2.7/32'), ['192.0.2.7']);
});

test('overlapping subnets and explicit addresses count unique hosts only', () => {
  assert.deepEqual(parseTargets('192.0.2.0/30 192.0.2.1 192.0.2.0/31 192.0.2.2/31', { maxHosts: 4 }),
    ['192.0.2.0', '192.0.2.1', '192.0.2.2', '192.0.2.3']);
  assert.equal(parseTargets('192.0.2.0/24 192.0.2.0/24', { maxHosts: 254 }).length, 254);
});

test('canonicalizes IPv6 aliases, using first longest zero run and lowercase', () => {
  assert.deepEqual(parseTargets('2001:0DB8:0000:0000:0000:0000:0000:0001 2001:db8::1 :: 0:0:0:0:0:0:0:0 ::1'),
    ['::', '::1', '2001:db8::1']);
  assert.deepEqual(parseTargets('2001:0:0:1:0:0:1:1'), ['2001::1:0:0:1:1']);
  assert.deepEqual(parseTargets('2001:db8:0:1:2:3:4:5'), ['2001:db8:0:1:2:3:4:5']);
});

test('IPv6 subnets include subnet zero, mask host bits and deduplicate overlap', () => {
  assert.deepEqual(parseTargets('2001:db8::3/126 2001:db8::1/128', { maxHosts: 4 }),
    ['2001:db8::', '2001:db8::1', '2001:db8::2', '2001:db8::3']);
  assert.deepEqual(parseTargets('::ffff/128'), ['::ffff']);
});

test('normalizes dotted and hexadecimal IPv4-mapped IPv6 aliases', () => {
  assert.deepEqual(parseTargets('::ffff:192.0.2.1 0:0:0:0:0:ffff:c000:0201 ::FFFF:C000:201'), ['::ffff:192.0.2.1']);
  assert.deepEqual(parseTargets('::192.0.2.1'), ['::c000:201']);
  assert.deepEqual(parseTargets('::ffff:192.0.2.3/127'), ['::ffff:192.0.2.2', '::ffff:192.0.2.3']);
});

test('refuses huge and overlapping huge subnets before host enumeration', { timeout: 1000 }, () => {
  for (const input of ['0.0.0.0/0', '::/0', '::/0 ::/64', '192.0.2.1 0.0.0.0/0']) {
    assert.throws(() => parseTargets(input, { maxHosts: 4096 }), error => error instanceof TargetValidationError && /unique hosts; the limit is 4,096/.test(error.message));
  }
  assert.throws(() => parseTargets('192.0.2.1 192.0.2.2', { maxHosts: 1 }), /2 unique hosts/);
  assert.equal(parseTargets('192.0.2.1 192.0.2.1', { maxHosts: 1 }).length, 1);
});

test('rejects ambiguous addresses, non-IP inputs, URLs, UNC paths and command syntax', () => {
  for (const input of [
    '', ' # only a comment', 'server.example.com', '192.168.001.1', '0127.0.0.1', '127.1', '0x7f000001',
    '256.0.0.1', '1.2.3.4.5', 'https://192.0.2.1', '\\\\192.0.2.1\\share', '192.0.2.1:445',
    '[2001:db8::1]:445', '[2001:db8::1]', 'fe80::1%eth0', '::gg', '1::2::3', '::ffff:192.000.2.1',
    '192.0.2.1/33', '::/129', '192.0.2.1/-1', '192.0.2.1/24/2', '192.0.2.1/', '::/01',
    '192.0.2.1 & whoami', '192.0.2.1|whoami', '192.0.2.1-192.0.2.5',
  ]) assert.throws(() => parseTargets(input), TargetValidationError, input);
  assert.throws(() => parseTargets(['192.0.2.1']), TargetValidationError);
});

test('optional limits must be positive integers, with null meaning uncapped', () => {
  for (const maxHosts of [0, -1, 1.5, Infinity, NaN, '4096', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseTargets('192.0.2.1', { maxHosts }), /maxHosts/);
  }
  assert.equal(parseTargets('192.0.2.1', { maxHosts: null }).length, 1);
});

test('targets above the old cap are accepted by default and expanded only on demand', () => {
  assert.equal(parseTargets('10.0.0.0/19').length, 8190);
  const plan = createTargetPlan('10.0.0.0/13 10.0.0.0/19');
  assert.equal(plan.count, 524286n);
  assert.equal(plan.length, 524286);
  assert.deepEqual(plan.preview(3), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  assert.equal(plan.at(500000), '10.7.161.33');
  assert.equal(plan.at(-1), '10.7.255.254');
  assert.equal(plan.at(plan.length), undefined);
});

test('very large IPv4 and IPv6 previews count ranges without expanding them', { timeout: 1000 }, () => {
  const ipv4 = createTargetPlan('0.0.0.0/0');
  assert.equal(ipv4.count, 4294967294n);
  assert.deepEqual(ipv4.preview(2), ['0.0.0.1', '0.0.0.2']);
  const ipv6 = createTargetPlan('::/0 ::/64');
  assert.equal(ipv6.count, 1n << 128n);
  assert.deepEqual(ipv6.preview(2), ['::', '::1']);
  assert.throws(() => ipv6.length, /exact integer range/);
});
